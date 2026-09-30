import { writeFile, open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { loadConfig } from "../src/config.ts";
import { applyAnchors, reportAnchors, anchorPlanSha256, type AnchorPlan } from "../src/adapters/anchor-maintenance.ts";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const values = (name: string) => args.flatMap((value, index) => value === name && args[index + 1] ? [args[index + 1]] : []);
const value = (name: string) => {
  const found = values(name);
  if (found.length !== 1) throw new Error(`Exactly one ${name} is required`);
  return found[0];
};
try {
  if (flag("--report") === flag("--apply")) throw new Error("Choose exactly one --report or --apply");
  const config = await loadConfig(value("--config"));
  const localPlanPath = async (path: string) => {
    const data = await realpath(config.data_dir), target = resolve(path);
    const parent = await realpath(dirname(target));
    if (parent !== data && !parent.startsWith(data + sep)) throw new Error("Plan must stay under local data_dir");
    return target;
  };
  if (flag("--report")) {
    const witnesses = values("--witness-fragment");
    if (!witnesses.length) throw new Error("At least one explicit --witness-fragment is required");
    const plan = await reportAnchors(config, values("--checkpoint"), witnesses);
    await writeFile(await localPlanPath(value("--output")), JSON.stringify(plan, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    console.log(JSON.stringify({ plan_sha256: anchorPlanSha256(plan), verified: plan.entries.filter(entry => entry.status === "verified").length,
      pending: plan.entries.filter(entry => entry.status === "pending").length }));
  } else {
    const handle = await open(await localPlanPath(value("--plan")), constants.O_RDONLY | constants.O_NOFOLLOW);
    let plan: AnchorPlan;
    try {
      const file = await handle.stat();
      if (!file.isFile() || file.size > 1048576) throw new Error("Invalid or oversized maintenance plan");
      plan = JSON.parse(await handle.readFile("utf8")) as AnchorPlan;
    } finally { await handle.close(); }
    console.log(JSON.stringify(await applyAnchors(config, plan, value("--expected-plan-sha"), flag("--single-writer-confirmed"))));
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
