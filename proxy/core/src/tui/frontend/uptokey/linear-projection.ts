import { renderItem, type TranscriptItem } from '../../transcript.ts'
import { getLang } from '../../i18n.ts'

/** Append settled output once. Tokens do not repaint the speech buffer, and a session change resets ownership. */
export class SettledTranscriptProjection {
  private session = ''
  private readonly versions = new Map<string, string>()
  take(session:string, items:readonly TranscriptItem[], width=100):string[] {
    if (session !== this.session) { this.session=session; this.versions.clear() }
    const output:string[]=[]
    for (const item of items) {
      if (item.kind === 'assistant' && item.streaming) continue
      if (item.kind === 'user') continue
      const version=JSON.stringify([getLang(),item])
      if(this.versions.get(item.id)===version)continue
      const text=renderItem(item,{width:Math.max(30,width),expanded:true,linear:true}).map(line=>line.spans.map(span=>span.text).join('')).join('\n')
      if (!text.trim()) continue
      this.versions.set(item.id,version)
      output.push(text)
    }
    // Prune removed live notices while retaining the settled history currently in the controller.
    const ids=new Set(items.map(item=>item.id))
    for(const id of this.versions.keys()) if(!ids.has(id)) this.versions.delete(id)
    return output
  }
}
