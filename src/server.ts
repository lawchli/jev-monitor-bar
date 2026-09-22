import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {EventStore} from './store';
export async function startServer(store:EventStore,sessionFile:string,port=0){
  const token=randomBytes(32).toString('hex');
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');
    const respond=(status:number,body:object)=>{res.writeHead(status);res.end(JSON.stringify(body));};
    if(req.headers.origin || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress??'')){respond(403,{error:'Origin rejected'});return;}
    const provided=Buffer.from(req.headers.authorization?.replace(/^Bearer /,'')??'');const expected=Buffer.from(token);
    if(provided.length!==expected.length||!timingSafeEqual(provided,expected)){respond(401,{error:'Local session credential required'});return;}
    if(req.method==='GET'&&req.url==='/health'){respond(200,{ok:true,cursor:store.cursor});return;}
    if(req.method!=='POST'||req.url!=='/events'){respond(404,{error:'Not found'});return;}
    if(!req.headers['content-type']?.startsWith('application/json')){respond(415,{error:'JSON required'});return;}
    const tooLarge=()=>{res.setHeader('Connection','close');respond(413,{error:'64 KiB event limit'});};
    if(Number(req.headers['content-length'])>65536){tooLarge();req.resume();return;}
    let size=0;const chunks:Buffer[]=[];
    try{
      // Breaking out of the body iterator destroys the socket before the 413 is flushed, so drain instead.
      for await(const chunk of req){size+=chunk.length;if(size<=65536)chunks.push(chunk);}
      if(size>65536){tooLarge();return;}
      let value:unknown;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{respond(400,{error:'Invalid JSON'});return;}
      try{const result=store.ingest(value);respond('conflict' in result?409:200,result);}catch(e){respond((e as NodeJS.ErrnoException).code?503:400,{error:(e as NodeJS.ErrnoException).code?'Storage unavailable':'Invalid protocol event'});}
    }catch{if(!res.headersSent)respond(400,{error:'Incomplete request'});}
  });
  server.requestTimeout=2000;server.headersTimeout=3000;server.maxConnections=32;
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const address=server.address() as {port:number};
  const session={url:`http://127.0.0.1:${address.port}`,token};
  fs.mkdirSync(path.dirname(sessionFile),{recursive:true});fs.writeFileSync(sessionFile,JSON.stringify(session),{mode:0o600});
  return {server,session,close:()=>new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();})};
}
