// Compile-only consumer contract; runtime/adversarial cases are in workflow.test.mjs.
import {
  parseExecutionPlan, parseProjectContext, parseRun, parseWorkflowCommand,
  parseUsageValueReceipt, validatePlanBindings,
  type ExecutionPlan, type ProjectContext, type Run, type UsageValueReceipt,
} from '../workflow.js';
export function consume(input: unknown) {
  const plan: ExecutionPlan = parseExecutionPlan(input);
  const project: ProjectContext = parseProjectContext(input);
  const run: Run = parseRun(input);
  const value: UsageValueReceipt = parseUsageValueReceipt(input);
  const create = parseWorkflowCommand('createProject', input);
  const name: string = create.name;
  const start = parseWorkflowCommand('startRun', input);
  const request: string = start.requestId;
  // @ts-expect-error owner is server-controlled, not a create-project command field.
  create.ownerPrincipalId;
  // @ts-expect-error arbitrary command names are not part of the public contract.
  parseWorkflowCommand('grantAdmin', input);
  return {plan,project,run,value,name,request,bindings:validatePlanBindings(plan,input,input)};
}
