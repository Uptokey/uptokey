/** Public endpoints documented by their maintainers; metadata discovery is
 * deliberately separate from chat compatibility. Manual entries require an
 * explicit model identifier and never pretend that a model was discovered.
 * No credential, selected account, quota or readiness is stored here. */
export interface CatalogProviderSetupPreset {
  id: `custom-${string}`;
  label: string;
  endpointUrl: string;
  protocol: 'openai';
  local: boolean;
  discovery: 'models' | 'manual' | 'catalog';
  documentationUrl: string;
  getKeyUrl?: string;
  /** Documented choices, never evidence of account access or a successful call. */
  modelIds?: readonly string[];
  modelsReviewedAt?: string;
  /** Only this preset's regional API host is accepted; never infer key region. */
  endpointRequired?: boolean;
  endpointPlaceholder?: string;
  endpointHostSuffix?: string;
  discoveryUrl?: string;
  discoveryFormat?: 'dashscope';
}

export const PROVIDER_SETUP_CATALOG_PRESETS: readonly CatalogProviderSetupPreset[] = Object.freeze([
  ...([
    ['singapore','Singapore','ap-southeast-1'],
    ['beijing','Beijing','cn-beijing'],
    ['hongkong','Hong Kong','cn-hongkong'],
    ['tokyo','Tokyo','ap-northeast-1'],
  ] as const).map(([id,label,region])=>({id:`custom-alibaba-${id}` as const,label:`Alibaba Cloud · ${label}`,endpointUrl:'',protocol:'openai' as const,local:false,discovery:'models' as const,discoveryFormat:'dashscope' as const,endpointRequired:true,endpointHostSuffix:`${region}.maas.aliyuncs.com`,endpointPlaceholder:`https://<workspace-id>.${region}.maas.aliyuncs.com`,documentationUrl:'https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope',getKeyUrl:'https://modelstudio.console.alibabacloud.com/'})),
  {id:'custom-meta',label:'Meta Model API',endpointUrl:'https://api.meta.ai/v1/chat/completions',protocol:'openai',local:false,discovery:'models',documentationUrl:'https://dev.meta.ai/docs/pricing-rate-limits',getKeyUrl:'https://dev.meta.ai/',modelIds:['muse-spark-1.3','muse-spark-1.2','muse-spark-1.1'],modelsReviewedAt:'2026-10-06'},
  {id:'custom-zai',label:'Z.AI',endpointUrl:'https://api.z.ai/api/paas/v4/chat/completions',protocol:'openai',local:false,discovery:'catalog',documentationUrl:'https://docs.z.ai/api-reference/llm/chat-completion',getKeyUrl:'https://z.ai/manage-apikey/apikey-list',modelIds:['glm-5.3','glm-5.3-flash','glm-5.2','glm-5.1','glm-5','glm-4.7','glm-4.7-flash','glm-4.5-flash'],modelsReviewedAt:'2026-10-06'},
  {id:'custom-zai-coding',label:'Z.AI Coding Plan',endpointUrl:'https://api.z.ai/api/coding/paas/v4/chat/completions',protocol:'openai',local:false,discovery:'catalog',documentationUrl:'https://docs.z.ai/devpack/tool/others',getKeyUrl:'https://z.ai/manage-apikey/apikey-list',modelIds:['glm-5.3','glm-5.3-flash','glm-5.2','glm-4.7'],modelsReviewedAt:'2026-10-06'},
  {id:'custom-kimi',label:'Kimi',endpointUrl:'https://api.moonshot.ai/v1/chat/completions',protocol:'openai',local:false,discovery:'manual',documentationUrl:'https://platform.kimi.ai/docs/guide/use-thinking-models'},
  {id:'custom-fireworks',label:'Fireworks AI',endpointUrl:'https://api.fireworks.ai/inference/v1/chat/completions',protocol:'openai',local:false,discovery:'manual',documentationUrl:'https://docs.fireworks.ai/tools-sdks/openai-compatibility'},
  {id:'custom-sambanova',label:'SambaNova',endpointUrl:'https://api.sambanova.ai/v1/chat/completions',protocol:'openai',local:false,discovery:'manual',documentationUrl:'https://docs.sambanova.ai/docs/en/integrations/vscode'},
  {id:'custom-deepinfra',label:'DeepInfra',endpointUrl:'https://api.deepinfra.com/v1/openai/chat/completions',protocol:'openai',local:false,discovery:'models',discoveryUrl:'https://api.deepinfra.com/v1/models',documentationUrl:'https://docs.deepinfra.com/api-reference/models/openai-models'},
  {id:'custom-siliconflow',label:'SiliconFlow',endpointUrl:'https://api.siliconflow.com/v1/chat/completions',protocol:'openai',local:false,discovery:'models',documentationUrl:'https://docs.siliconflow.com/en/api-reference/models/get-model-list'},
  {id:'custom-nebius',label:'Nebius Token Factory',endpointUrl:'https://api.tokenfactory.nebius.com/v1/chat/completions',protocol:'openai',local:false,discovery:'models',documentationUrl:'https://docs.tokenfactory.nebius.com/api-reference/models/list-models'},
  {id:'custom-novita',label:'Novita AI',endpointUrl:'https://api.novita.ai/openai/v1/chat/completions',protocol:'openai',local:false,discovery:'models',documentationUrl:'https://docs.novita.ai/api-reference/model-apis-llm-list-models'},
  {id:'custom-minimax',label:'MiniMax',endpointUrl:'https://api.minimax.io/v1/chat/completions',protocol:'openai',local:false,discovery:'manual',documentationUrl:'https://platform.minimax.io/docs/api-reference/text-openai-api'},
  {id:'custom-pollinations',label:'Pollinations',endpointUrl:'https://gen.pollinations.ai/v1/chat/completions',protocol:'openai',local:false,discovery:'models',documentationUrl:'https://github.com/pollinations/pollinations/blob/main/README.md#openai-sdk-compatibility'},
  {id:'custom-localai',label:'LocalAI',endpointUrl:'http://127.0.0.1:8080/v1/chat/completions',protocol:'openai',local:true,discovery:'manual',documentationUrl:'https://github.com/mudler/LocalAI#usage'},
].map(preset=>Object.freeze({...preset,...('modelIds' in preset?{modelIds:Object.freeze(preset.modelIds)}:{})} as CatalogProviderSetupPreset)));
