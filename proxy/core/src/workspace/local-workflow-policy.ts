import { canonicalJson } from '@uptokey/sync-contract/canonical';
import { parseProjectRunRequest } from '@uptokey/sync-contract/project-agent';
import { parseWorkflowCommand, type CapabilityDescriptor, type ExecutionPlan } from '@uptokey/sync-contract/workflow';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import { PROJECT_WRITE_CAPABILITY } from './capabilities.ts';
import { PROJECT_RUN_CAPABILITY } from './project-run-plans.ts';

/** Positive proof, not a destination-label heuristic. These two built-in adapters
 * write a reviewed change set or run with --pull=never/--network=none. Host
 * commands, learned/custom capabilities and dependency acquisition are excluded. */
export function isLocalWorkflowPlan(plan: ExecutionPlan, capabilities: readonly CapabilityDescriptor[]): boolean {
  return plan.steps.length > 0 && plan.steps.every(step => {
    const expected = [PROJECT_WRITE_CAPABILITY, PROJECT_RUN_CAPABILITY].find(cap => cap.id === step.capabilityId && cap.version === step.capabilityVersion);
    const actual = capabilities.find(cap => cap.id === step.capabilityId && cap.version === step.capabilityVersion);
    if (!expected || !actual || canonicalJson(actual) !== canonicalJson(expected)) return false;
    if (expected.id === PROJECT_WRITE_CAPABILITY.id) return true;
    const binding = step.arguments.request;
    return binding?.kind === 'literal' && isLocalRunnerRequest(binding.value);
  });
}

export function isLocalRunnerRequest(input: unknown): boolean {
  try {
    const request = parseProjectRunRequest(input);
    return ['static-web', 'node-app', 'python-app'].includes(request.runtimeProfileId)
      && request.actionId !== 'preview' && !request.execution?.dependencies?.length;
  } catch { return false; }
}

/** Preparation endpoints below have no execution/network side effects. Consent
 * and start additionally require the saved plan, never a plan supplied by UI. */
export async function isLocalWorkflowRequest(path: string, body: unknown, readPlan: (project: string, planId: string) => Promise<ExecutionPlan | undefined>, capabilities: readonly CapabilityDescriptor[]): Promise<boolean> {
  const match = /^\/v1\/workspace\/projects\/([A-Za-z0-9][A-Za-z0-9_-]{0,99})\/(.+)$/.exec(path);
  if (!match) return false;
  const [, project, operation] = match;
  if (/^project-agent\/(?:preflight|plans|run-promotions)$/.test(operation!)) return true;
  if (/^project-roots\/[A-Za-z0-9][A-Za-z0-9_-]{0,99}\/restore-(?:file|turn)$/.test(operation!)) return true;
  if (operation === 'project-agent/run-plans') return isDataRecord(body) && isLocalRunnerRequest(body.request);
  if (!['consent/challenge', 'consent/complete', 'runs/start'].includes(operation!)) return false;
  try {
    const command = parseWorkflowCommand('startRun', operation === 'consent/complete' && isDataRecord(body) ? body.command : body);
    const plan = await readPlan(project!, command.planId);
    return !!plan && plan.digest === command.planDigest && isLocalWorkflowPlan(plan, capabilities);
  } catch { return false; }
}
