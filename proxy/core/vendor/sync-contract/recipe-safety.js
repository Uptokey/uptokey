// Pure recipe data checks shared by local import and hosted publication.
// Input is declarative recipe data, validated/bounded by its receiving endpoint.
// These checks reduce accidental sharing; they are neither a complete semantic
// classifier nor an HTML sanitizer. Execution authorization and safe rendering
// remain mandatory independent boundaries.
export function assertNoForbiddenContent(data) {
    const forbiddenPatterns = [
        /\b(?:utk_|sk-|gsk-|csk-)[A-Za-z0-9._-]{8,}\b/i,
        /AIza[A-Za-z0-9_-]{30,}/,
        /\bAQ\.[A-Za-z0-9_-]{20,}/,
        /\bLLM\|[0-9]{1,32}\|[A-Za-z0-9._-]{8,}/,
        /AKIA[A-Z0-9]{16}/,
        /(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9]{22}_[A-Za-z0-9]{59}/,
        /xox[baprs]-[A-Za-z0-9]{10,}/,
        /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
        /(?:uptokey|utk)[_-]canary[_-][A-Za-z0-9_-]{8,}/i,
        /\bauthorization\s*[:=]\s*(?:bearer|basic)\s+[^\s]+/i,
        /\bbearer\s+[A-Za-z0-9._~+/-]{16,}={0,2}/i,
        /^[A-Za-z]:\\[^<>:"/\\|?*\n\r]+/m,
        /^\/(?:home|Users|etc|var|tmp)\/[^/\0]+/m,
        /\bgrant_[A-Za-z0-9_-]{6,}\b/i
    ];
    function inspect(val, path = "") {
        if (typeof val === "string") {
            for (const pattern of forbiddenPatterns){
                if (pattern.test(val)) {
                    throw new Error(`forbidden_recipe_content_detected:at_${path || "root"}`);
                }
            }
            assertNoSecretSolicitationValue(val, path);
            assertNoDangerousLinkValue(val, path);
        } else if (Array.isArray(val)) {
            val.forEach((item, idx)=>inspect(item, `${path}[${idx}]`));
        } else if (val && typeof val === "object") {
            for (const [k, v] of Object.entries(val)){
                const keyWords = k.replace(/([a-z])([A-Z])/g, "$1_$2").replace(/-/g, "_");
                if (/(?:^|_)(?:credentials?|grants?|secrets?|api_?key|password|access_?token|refresh_?token|private_?key|authorization)(?:_|$)/i.test(keyWords)) {
                    throw new Error(`forbidden_recipe_key_detected:${k}`);
                }
                inspect(v, `${path}.${k}`);
            }
        }
    }
    inspect(data);
}
export function assertNoSecretSolicitation(data) {
    const walk = (val, path = "")=>{
        if (typeof val === "string") assertNoSecretSolicitationValue(val, path);
        else if (Array.isArray(val)) val.forEach((item, idx)=>walk(item, `${path}[${idx}]`));
        else if (val && typeof val === "object") for (const [k, v] of Object.entries(val))walk(v, `${path}.${k}`);
    };
    walk(data);
}
function assertNoSecretSolicitationValue(val, path) {
    // Negation applies to the matched imperative only, never to later requests.
    const solicitationPatterns = [
        /\b(?:cole|cola|informe|insira|digite|forne[cç]a|compartilhe|envie)\s+(?:sua\s+|seu\s+|o\s+|a\s+|os\s+|as\s+)?(?:api[\s_-]?key|chave\s+(?:de\s+api|privada)|senha|password|secret|token|credencial|private\s+key)\b/gi,
        /\b(?:provide|paste|enter|share|send|upload)\s+(?:your\s+|the\s+|a\s+)?(?:api[\s_-]?key|password|secret|token|credential|private\s+key)\b/gi,
        /\bsua\s+(?:api[\s_-]?key|senha|password|secret|token)\s+(?:aqui|abaixo)\b/gi,
        /\byour\s+(?:api[\s_-]?key|password|secret|token)\s+(?:here|below)\b/gi
    ];
    const negatedRanges = [];
    for (const pattern of solicitationPatterns){
        for (const match of val.matchAll(pattern)){
            if (negatedRanges.some(([start, end])=>match.index >= start && match.index < end)) continue;
            const prefix = val.slice(0, match.index).normalize("NFKC");
            if (/(?:\b(?:não|nao|nunca|jamais|never)|\bdo\s+not|\bdon['’]t)\s+$/i.test(prefix)) {
                negatedRanges.push([
                    match.index,
                    match.index + match[0].length
                ]);
                continue;
            }
            throw new Error(`forbidden_secret_solicitation_detected:at_${path || "root"}`);
        }
    }
}
export function assertNoDangerousLinks(data) {
    const walk = (val, path = "")=>{
        if (typeof val === "string") assertNoDangerousLinkValue(val, path);
        else if (Array.isArray(val)) val.forEach((item, idx)=>walk(item, `${path}[${idx}]`));
        else if (val && typeof val === "object") for (const [k, v] of Object.entries(val))walk(v, `${path}.${k}`);
    };
    walk(data);
}
function assertNoDangerousLinkValue(val, path) {
    // Normalize browser-relevant entity/control obfuscation, without treating
    // this string scan as permission to render untrusted HTML.
    const normalized = val.replace(/&#(?:x([0-9a-f]{1,6})|([0-9]{1,7}));?|&(colon|tab|newline);/gi, (entity, hex, decimal, named)=>{
        if (named) return ({
            colon: ":",
            tab: "\t",
            newline: "\n"
        })[named.toLowerCase()];
        const code = Number.parseInt(hex ?? decimal, hex ? 16 : 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    }).replace(/[\t\n\r]/g, "");
    const linkPatterns = [
        /\bjavascript\s*:/i,
        /\bvbscript\s*:/i,
        /\bfile\s*:/i,
        /\bdata\s*:\s*(?:text\/(?:html|xml)|application\/(?:xhtml\+xml|xml)|image\/svg\+xml)/i
    ];
    for (const pattern of linkPatterns){
        if (pattern.test(normalized)) {
            throw new Error(`forbidden_unsafe_link_detected:at_${path || "root"}`);
        }
    }
}
