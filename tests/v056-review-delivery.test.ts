import { expect, test } from "bun:test";
import { Ledger } from "../src/ledger";
import { withReviewDelivery } from "./helpers/review-delivery";

for (const scenario of ["pass", "fallback"] as const) test(
  `exact delivery rejects historical ${scenario} tool receipts as native review`, () => {
    withReviewDelivery(f => {
      const head = f.change("review target");
      // Use the ledger writer only for the retired tool's fixture receipt.
      const db = new Ledger(f.s.work);
      try {
        const spec = db.getSpecState(f.task);
        db.recordEvidence({task_id: f.task, repo: "app", branch: "main", sha: head, kind: "review",
          actor: "tool", source: "tool", status: scenario, summary: "Historical full review",
          meta: {role: "quality", base: f.base, head, review_task_id: f.task, freeze_seq: spec.freeze_seq,
            review_floor_seq: spec.evidence_floor_seq.review, ...(scenario === "pass" ? {report_status: "pass"} : {})}});
      } finally { db.closeDb(); }
      const historical = f.reviews();
      expect(historical).toMatchObject([{source: "tool", role: "quality", status: scenario, base: f.base, head}]);
      f.verify();
      const before = f.deliveryEvents();
      expect(f.blocked(f.authorize(), "run")).toMatch(/independent review/i);
      expect(f.remote()).toBe(f.base);
      const ordinaryClose = f.s.run([f.s.forge, "ledger", "close", f.task]);
      expect(ordinaryClose.code).toBe(1);
      expect(ordinaryClose.out + ordinaryClose.err).toMatch(/independent review/i);
      expect(f.status().task.status).toBe("OPEN");
      expect(f.deliveryEvents()).toEqual(before);

      if (scenario === "fallback") {
        const reason = "Operator records incomplete review on the old task";
        expect(f.ledger("close", f.task, "--force-incomplete", "--reason", reason).task.status).toBe("CLOSED");
        expect(JSON.parse(f.status().events.at(-1).payload_json)).toMatchObject({force_incomplete: true, force_reason: reason});
        expect(f.reviews()).toEqual(historical);
        expect(f.remote()).toBe(f.base);
        expect(f.deliveryEvents()).toEqual(before);
        return;
      }

      f.native(f.base, head);
      f.deliver(f.authorize());
      expect(f.reviews().slice(0, historical.length)).toEqual(historical);
    });
  }, 30_000,
);
