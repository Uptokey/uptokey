import {projectInferenceRequest,hasForbiddenInferenceCredentialField} from './inference-request-policy.ts';
import type {Router} from './router.ts';

/** Shared final validation for HTTP adapters and internally planned requests.
 * Authentication, entitlement and admission are checked by each entry point;
 * quota, context guard, cache and provider routing remain owned by Router.
 */
export async function dispatchInference(router:Pick<Router,'dispatch'>,input:unknown,options:Parameters<Router['dispatch']>[1],signal:AbortSignal):Promise<Response> {
  const request=projectInferenceRequest(input);
  if(!request)return Response.json({error:{type:'invalid_request'}},{status:400});
  if(hasForbiddenInferenceCredentialField(request))return Response.json({error:{type:'credential_field_forbidden'}},{status:400});
  return router.dispatch(request,options,signal);
}
