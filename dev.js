// Local dev server: serves public/ and runs api/app.js. Not used on Vercel.
const http=require('http'),fs=require('fs'),path=require('path'),handler=require('./api/app.js');
const types={'.html':'text/html','.js':'text/javascript','.webmanifest':'application/manifest+json'};
http.createServer(async(req,res)=>{
  const u=new URL(req.url,'http://localhost');
  if(u.pathname.startsWith('/api/')){
    let raw='';for await(const c of req)raw+=c;
    req.query={...Object.fromEntries(u.searchParams),r:u.pathname.slice(5)};
    try{req.body=raw?JSON.parse(raw):{}}catch{req.body={}}
    res.status=c=>{res.statusCode=c;return res};
    res.json=o=>{res.setHeader('content-type','application/json');res.end(JSON.stringify(o))};
    return handler(req,res);
  }
  const f=path.join(__dirname,'public',u.pathname==='/'?'index.html':u.pathname);
  fs.readFile(f,(e,d)=>{if(e){res.statusCode=404;return res.end('Not found')}
    res.setHeader('content-type',types[path.extname(f)]||'application/octet-stream');res.end(d)});
}).listen(3000,()=>console.log('KickPing running at http://localhost:3000'));
