import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require=createRequire('/opt/harness/package.json');
const { Context }=await import(require.resolve('@deepseek-ai/cordis'));
const { default: OfficeToPdf }=await import(require.resolve('@deepseek-ai/dsh-office-to-pdf'));
// A minimal synthetic DOCX; no user document or network is involved.
const bytes=execFileSync('python3',['-c',`
import io,sys,zipfile
b=io.BytesIO()
with zipfile.ZipFile(b,'w',zipfile.ZIP_DEFLATED) as z:
 z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
 z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
 z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic local document</w:t></w:r></w:p><w:sectPr/></w:body></w:document>')
sys.stdout.buffer.write(b.getvalue())
`]);
const ctx=new Context();
try {
 await ctx.plugin(OfficeToPdf,{maxConcurrentConversions:1,timeoutMs:30000});
 const result=await ctx.officeToPdf.convert({extension:'docx',priority:'foreground',source:{key:'lab-synthetic-docx',version:'v1',bytes:bytes.length,read:async()=>({bytes,version:'v1'})}},AbortSignal.timeout(35000));
 assert.equal(Buffer.from(result.pdf.subarray(0,5)).toString(),'%PDF-');
 assert.ok(result.pdf.length>100);
 console.log(JSON.stringify({nativeOfficeConversion:true,source:'synthetic.docx',output:'PDF',outputBytes:result.pdf.length,missingFonts:result.missingFonts,cloudConversion:false}));
} finally {await ctx.fiber.dispose()}
