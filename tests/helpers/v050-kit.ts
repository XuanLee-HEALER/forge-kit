import { historicalKit } from "./historical-kit";
import type { Sandbox } from "../v05-sandbox";

export function historicalV050Kit(s: Sandbox) {
  return historicalKit(s, "0.5.0");
}
