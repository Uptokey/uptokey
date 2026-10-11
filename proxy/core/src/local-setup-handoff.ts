import {isNamedExperimentalProvider,isUserDefinedProvider} from "./provider-registry.ts";
import {validInstallModel} from "./local-model-install.ts";

export function localSetupConnection(search: URLSearchParams): string | undefined {
  if(search.getAll("setup").length!==1||search.get("setup")!=="connection"||search.getAll("provider").length!==1||
    [...search.keys()].some(key=>key!=="setup"&&key!=="provider"))return undefined;
  const provider=search.get("provider");
  return isUserDefinedProvider(provider)?provider:undefined;
}

/** Named preset only. No endpoint, key, model override or consent comes from this hint. */
export function localSetupProvider(search: URLSearchParams) {
  if (search.getAll("setup").length !== 1 || search.get("setup") !== "provider" || search.getAll("provider").length !== 1 ||
      [...search.keys()].some(key => key !== "setup" && key !== "provider")) return undefined;
  const provider = search.get("provider");
  return isNamedExperimentalProvider(provider) ? provider : undefined;
}

/** URL hints only prepare the local form. They never mutate configuration or grant consent. */
export function localSetupModel(search: URLSearchParams): string | undefined {
  if (search.getAll("setup").length !== 1 || search.get("setup") !== "ollama" || search.getAll("model").length !== 1) return undefined;
  if ([...search.keys()].some(key => key !== "setup" && key !== "model")) return undefined;
  const model = search.get("model") ?? "";
  return validInstallModel(model) ? model : undefined;
}
