// Embedded in the Bun supervisor. Each filter operates on reversible Latin-1
// strings and keeps a bounded lookahead, so arbitrary compiler bytes survive.
type Sink = (data: string) => void;

// Only URI authorities and JWT headers require deferred disclosure. A field
// still ambiguous at 64 KiB is masked in full. Ordinary output never spills.
class Candidate {
  private text = "";
  private oversized = false;
  end = "";
  add = (part: string) => {
    this.end = (this.end + part.slice(-16)).slice(-16);
    if (this.oversized) return;
    if (this.text.length + part.length > 65536) { this.oversized = true; this.text = ""; }
    else this.text += part;
  };
  release(out: Sink, trim = 0) {
    out(this.oversized ? "***" : this.text.slice(0, this.text.length - trim));
  }
}

class Input {
  text = "";
  eof = false;
  previousWord = false;
  uppercaseBoundary = true;
  *ensure(n: number): Generator<void, void, string | undefined> {
    while (!this.eof && this.text.length < n) {
      const chunk = yield;
      if (chunk === undefined) this.eof = true;
      else this.text += chunk;
    }
  }
  take(n: number, out?: Sink) {
    if (!n) return;
    const part = this.text.slice(0, n);
    if (out) out(part);
    this.previousWord = /\w/.test(part.at(-1)!);
    let i = part.length;
    while (i && /[A-Z_]/.test(part[i - 1])) i--;
    if (i) {
      this.uppercaseBoundary = !/\w/.test(part[i - 1]);
    }
    this.text = this.text.slice(n);
  }
  *until(stop: RegExp, out?: Sink) {
    for (;;) {
      yield* this.ensure(1);
      if (!this.text.length) return;
      const end = this.text.search(stop);
      this.take(end < 0 ? this.text.length : end, out);
      if (end >= 0) return;
    }
  }
}

type Rule = (input: Input, match: RegExpExecArray, out: Sink) => Generator<void, void, string | undefined>;
function filter(start: RegExp, rule: Rule, out: Sink) {
  const input = new Input();
  function* process(): Generator<void, void, string | undefined> {
    for (;;) {
      yield* input.ensure(48);
      if (!input.text) return;
      const match = start.exec(input.text);
      // Retain a split introducer until its following delimiter is available.
      const limit = input.eof ? input.text.length : input.text.length - 32;
      if (!match || match.index >= limit) { input.take(limit, out); continue; }
      input.take(match.index, out);
      yield* rule(input, match, out);
    }
  }
  const parser = process();
  parser.next();
  return (chunk?: string) => { parser.next(chunk); };
}

function verificationRedactor(write: Sink) {
  const stages: ReturnType<typeof filter>[] = [];
  let out = write;
  function prepend(pattern: RegExp, rule: Rule) {
    const stage = filter(pattern, rule, out);
    stages.unshift(stage);
    out = stage;
  }
  // Later filters also see public text released by earlier filters.
  prepend(/sk-[A-Za-z0-9_-]{16}/, function*(input, _match, send) {
    if (input.previousWord) { input.take(3, send); return; }
    send("sk-***");
    input.take(3);
    yield* input.until(/[^A-Za-z0-9_-]/);
  });
  function* value(input: Input, send: Sink): Generator<void, void, string | undefined> {
    yield* input.ensure(1);
    if (!input.text || /^[ \t-\r]/.test(input.text)) return;
    send("***");
    const quote = input.text[0];
    if (quote !== "'" && quote !== '"') { yield* input.until(/[ \t-\r]/); return; }
    input.take(1);
    const stop = quote === "'" ? /'/ : /["\\]/;
    for (;;) {
      yield* input.until(stop);
      if (!input.text) return;
      if (input.text[0] === quote) { input.take(1); return; }
      yield* input.ensure(2);
      input.take(2);
    }
  }
  prepend(/--(?:password|passwd|token|secret|api[-_]key|auth[-_]token)(?==|[ \t])/i, function*(input, match, send) {
    input.take(match[0].length, send);
    if (input.text[0] === "=") input.take(1, send);
    else yield* input.until(/[^ \t]/, send);
    yield* value(input, send);
  });
  prepend(/SECRET|TOKEN|PASSWORD|API_KEY|MYSQL_PWD|REDISCLI_AUTH/, function*(input, match, send) {
    const exact = match[0] === "MYSQL_PWD" || match[0] === "REDISCLI_AUTH";
    const allowed = exact ? !input.previousWord : input.uppercaseBoundary;
    input.take(match[0].length, send);
    if (!allowed) return;
    if (!exact) yield* input.until(/[^A-Z_]/, send);
    if (!input.text.startsWith("=")) return;
    input.take(1, send);
    yield* value(input, send);
  });
  prepend(/eyJ[A-Za-z0-9_-]{10}/, function*(input, _match, send) {
    const header = new Candidate();
    yield* input.until(/[^A-Za-z0-9_-]/, header.add);
    yield* input.ensure(11);
    if (!/^\.[A-Za-z0-9._-]{10}/.test(input.text)) { header.release(send); return; }
    send("***");
    yield* input.until(/[^A-Za-z0-9._-]/);
  });
  prepend(/Bearer(?=[ \t-\r])/i, function*(input, match, send) {
    input.take(match[0].length, send);
    yield* input.until(/[^ \t-\r]/, send);
    yield* input.ensure(8);
    if (!/^[A-Za-z0-9._~+/=-]{8}/.test(input.text)) return;
    send("***");
    yield* input.until(/[^A-Za-z0-9._~+/=-]/);
  });
  prepend(/(?:https?|postgres(?:ql)?|mysql|redis|clickhouse):\/\//i, function*(input, match, send) {
    input.take(match[0].length, send);
    const authority = new Candidate();
    yield* input.until(/[ \t-\r/?#@"]/, authority.add);
    if (!input.text.startsWith("@")) {
      const nested = input.text.startsWith("/") && /(?:https?|postgres(?:ql)?|mysql|redis|clickhouse):$/i.exec(authority.end);
      authority.release(send, nested ? nested[0].length : 0);
      if (nested) input.text = nested[0] + input.text;
      return;
    }
    if (authority.end) send("***");
    input.take(1, send);
  });
  return { write: out, finish: () => { for (const stage of stages) stage(); } };
}
