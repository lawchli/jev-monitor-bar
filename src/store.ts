import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {validateEvent,type MonitorEvent,type StoredEvent} from './protocol';
import {sanitizeEvent} from './redact';
import {applyEvent,emptyRun,type RunState} from './state';

export class EventStore extends EventEmitter {
  events:StoredEvent[]=[]; runs=new Map<string,RunState>(); ids=new Set<string>(); sequences=new Set<string>();
  cursor=0; bytes=0; corruptLines=0; private segment=0; private segmentBytes=0;
  constructor(public directory:string,public maxEvents=20000,public segmentLimit=4*1024*1024,public maxSegments=8,public diagnostics=false){
    super();fs.mkdirSync(directory,{recursive:true});
    const files=this.files();
    // Only recover bounded retained segments; malformed/torn final lines are counted.
    for(const f of files.slice(-maxSegments)){
      this.segment=Math.max(this.segment,Number(f.slice(7,15)));
      for(const line of fs.readFileSync(path.join(directory,f),'utf8').split('\n')){
        if(!line)continue;
        try {const row=JSON.parse(line);const {received_at,cursor,...event}=row;validateEvent(event);
          if(typeof received_at!=='string'||!Number.isSafeInteger(cursor))throw new Error('Invalid envelope');
          this.cursor=Math.max(this.cursor,cursor);this.remember(sanitizeEvent(row,diagnostics));
        }catch{this.corruptLines++;}
      }
    }
    // A fresh segment after every restart isolates torn writes from valid records.
    this.segment++;this.pruneFiles();
  }
  private files(){return fs.readdirSync(this.directory).filter(f=>/^events-\d{8}\.jsonl$/.test(f)).sort();}
  private file(){return path.join(this.directory,`events-${String(this.segment).padStart(8,'0')}.jsonl`);}
  private pruneFiles(){const files=this.files();for(const f of files.slice(0,Math.max(0,files.length-this.maxSegments)))fs.unlinkSync(path.join(this.directory,f));}
  private seq(e:MonitorEvent){return JSON.stringify([e.run_id,e.producer_id,e.sequence]);}
  private remember(e:StoredEvent){
    if(this.ids.has(e.event_id)||this.sequences.has(this.seq(e)))return;
    this.ids.add(e.event_id);this.sequences.add(this.seq(e));this.events.push(e);this.bytes+=Buffer.byteLength(JSON.stringify(e));
    let r=this.runs.get(e.run_id);if(!r){r=emptyRun(e.run_id);this.runs.set(e.run_id,r);}applyEvent(r,e);
    while(this.runs.size>200)this.runs.delete(this.runs.keys().next().value!);
    while(this.events.length>this.maxEvents||this.bytes>32*1024*1024){const old=this.events.shift()!;this.ids.delete(old.event_id);this.sequences.delete(this.seq(old));this.bytes-=Buffer.byteLength(JSON.stringify(old));}
  }
  ingest(raw:unknown){
    validateEvent(raw);
    if(this.ids.has(raw.event_id)||this.sequences.has(this.seq(raw)))return {accepted:false,cursor:this.cursor};
    const e:StoredEvent={...sanitizeEvent(raw,this.diagnostics),received_at:new Date().toISOString(),cursor:this.cursor+1};
    const line=JSON.stringify(e)+'\n';const size=Buffer.byteLength(line);
    if(this.segmentBytes+size>this.segmentLimit){this.segment++;this.segmentBytes=0;}
    // Commit on disk before acknowledgement; append failure never becomes a successful send.
    fs.appendFileSync(this.file(),line);this.segmentBytes+=size;this.pruneFiles();this.cursor=e.cursor;
    this.remember(e);this.emit('event',e);return {accepted:true,cursor:e.cursor};
  }
  snapshot(runId?:string){return {cursor:this.cursor,runs:[...this.runs.values()].map(({decisions,attempts,...r})=>r),run:runId?this.runs.get(runId):undefined,events:this.events.filter(e=>!runId||e.run_id===runId).slice(-400),corruptLines:this.corruptLines};}
  exportLines(){return this.files().map(f=>fs.readFileSync(path.join(this.directory,f),'utf8')).join('');}
}
