/**
 * Detects an answer that claims the work succeeded ("the tests pass now", "fixed", "works now") in the ten interface
 * languages. A claim is only a sentence of the model: the TUI uses this to offer the project's verification instead
 * of taking the claim as evidence. Deterministic and conservative: negated or failure sentences do not count.
 */

const letters = (source: string) => new RegExp(`(?<!\\p{L})(?:${source})(?!\\p{L})`, "iu");

/** Positive claims per language family (alphabetic languages use letter boundaries). */
const CLAIMS: readonly RegExp[] = [
  // English
  letters("(?:tests?|specs?|suite)[^.!?\\n]{0,40}(?:pass(?:es|ed|ing)?|green|succeed(?:s|ed)?)"),
  letters("(?:all|now)[^.!?\\n]{0,20}pass(?:es|ing)?"),
  letters("fixed|resolved|works now|now works|should (?:now )?work|is working(?: now)?"),
  // Portuguese
  letters("testes?[^.!?\\n]{0,40}(?:passa(?:m|ram|ndo)?|verdes?)"),
  letters("corrigid[oa]s?|resolvid[oa]s?|funciona(?:ndo)?(?: agora)?|deve funcionar"),
  // Spanish
  letters("(?:pruebas?|tests?)[^.!?\\n]{0,40}(?:pasa(?:n|ron|ndo)?)"),
  letters("corregid[oa]s?|arreglad[oa]s?|resuelt[oa]s?|funciona(?: ahora)?"),
  // French
  letters("tests?[^.!?\\n]{0,40}(?:passe(?:nt)?|réussi(?:ssent|t)?)"),
  letters("corrigée?s?|résolue?s?|fonctionne(?: maintenant)?"),
  // German
  letters("tests?[^.!?\\n]{0,40}(?:bestehen|besteht|laufen durch|grün)"),
  letters("behoben|gelöst|funktioniert(?: jetzt)?"),
  // Italian
  letters("test[^.!?\\n]{0,40}(?:passa(?:no)?|superat[oi])"),
  letters("corrett[oa]|risolt[oa]|funziona(?: ora)?"),
  // Japanese, Korean, Chinese, Arabic
  /テスト[^。\n]{0,20}(?:通り|通過|パス|成功)|修正(?:しました|済み)|解決しました|動作します/u,
  /테스트[^.\n]{0,20}(?:통과|성공)|수정(?:했|되었|완료)|해결(?:했|되었)|작동합니다/u,
  /测试[^。\n]{0,20}(?:通过|成功)|已修复|修复了|已解决|可以正常(?:工作|运行)/u,
  /الاختبارات?[^.\n]{0,30}(?:تنجح|نجحت|ناجحة)|تم (?:الإصلاح|إصلاح|حل)|يعمل الآن/u,
];

/** A sentence that reports failure or negates the result is not a success claim. */
const DOUBT: readonly RegExp[] = [
  letters("not|cannot|no longer|still fail(?:s|ing)?|fail(?:s|ed|ing|ure)?|unable|might|maybe|probably|unverified"),
  /n['’]t(?!\p{L})/iu,
  letters("não|ainda falha|falha(?:m|ram|ndo)?|talvez|provavelmente"),
  // Spanish "no" only as a verb negation (Portuguese "no" means "in the").
  letters("no (?:pasa|pasan|funciona|se)|todavía falla|falla(?:n|ron)?|quizás|tal vez|probablemente"),
  letters("pas|n['’](?:est|a|ont)|échoue(?:nt)?|échec|peut-être|probablement"),
  letters("nicht|kein(?:e|en)?|schlägt fehl|fehlgeschlagen|vielleicht|wahrscheinlich"),
  letters("non|fallisce|fallit[oi]|forse|probabilmente"),
  /失敗|できません|ません|かもしれ/u,
  /실패|않|못|아마/u,
  /失败|没有|未|不能|可能/u,
  /فشل|لا |لم |ربما/u,
];

export function claimsSuccess(answer: string): boolean {
  // Code blocks are not prose claims (a test file may contain "passes").
  const prose = answer.replace(/```[\s\S]*?```/g, " ");
  const sentences = prose.split(/(?<=[.!?。！？])\s+|\n+/u);
  return sentences.some((sentence) => CLAIMS.some((claim) => claim.test(sentence)) && !DOUBT.some((doubt) => doubt.test(sentence)));
}
