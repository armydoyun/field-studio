// 개발용 정적 서버 (127.0.0.1 전용). ES Module 소스를 http://로 열기 위해서만 사용한다.
const http=require("node:http"),fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),port=Number(process.argv[2])||8765;
const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json",".png":"image/png"};
http.createServer((req,res)=>{
  const url=decodeURIComponent(new URL(req.url,"http://x").pathname);
  const file=path.resolve(root,"."+(url.endsWith("/")?url+"index.html":url));
  if(!file.startsWith(root)){res.writeHead(403);return res.end();}
  fs.readFile(file,(error,data)=>{
    if(error){res.writeHead(404);return res.end("not found");}
    res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream","Cache-Control":"no-store"});res.end(data);
  });
}).listen(port,"127.0.0.1",()=>console.log(`serving ${root} on http://127.0.0.1:${port}/`));
