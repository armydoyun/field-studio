// Every supported numeric type and its array variant must survive annotation -> registry -> GPU.
(async()=>{
  const r=window.shaderPlayground,studio=window.shaderStudio,settings=window.shaderSettings;
  const check=(ok,label)=>{if(!ok)throw new Error(label);console.log(`PASS ${label}`);};
  const old=studio.getProject(),users=r.getUserUniforms(),links=settings.getLinks();
  const types=['float','int','uint','bool',...['vec','ivec','uvec','bvec'].flatMap(prefix=>[2,3,4].map(n=>prefix+n)), 'mat2','mat3','mat4'];
  const cases=[],declarations=[];
  let offline=false;
  try {
    settings.setLinks([]);
    for(const type of types) for(const array of [false,true]) {
      const dim=Number(type.at(-1))||1, matrix=type.startsWith('mat'), n=matrix?dim*dim:dim;
      const kind=type.startsWith('b')?'b':/^(uvec|uint)/.test(type)?'u':/^(ivec|int)/.test(type)?'i':'f';
      const count=array?2:1,name=`uTest${cases.length}`;
      const values=Array.from({length:n*count},(_,i)=>kind==='b'?i%2===0:kind==='u'?i+3:kind==='i'?-(i+2):(i%2?-1:1)*(i+1)*0.25);
      const terms=values.map((value,i)=>{
        const component=i%n,base=array?`${name}[${Math.floor(i/n)}]`:name;
        const expr=matrix?`${base}[${Math.floor(component/dim)}][${component%dim}]`:n>1?`${base}[${component}]`:base;
        return `${kind==='b'?`(${expr}?1.0:0.0)`:`float(${expr})`}*${i+1}.0`;
      });
      declarations.push(`uniform ${type} ${name}${array?'[2]':''}; // @default ${values.map(String).join(' ')}`);
      cases.push({name,type:type+(array?'[2]':''),values,expression:terms.join('+'),expected:values.reduce((sum,value,i)=>sum+Number(value)*(i+1),0),tolerance:1e-5});
    }
    declarations.push('uniform sampler2D uGradient; // @gradient linear @default 0 #ff0000 1 #0000ff','uniform sampler2D uCurve; // @curve linear @range -1 1 @default 0 -1 1 1');
    cases.push({name:'uGradient',expression:'texture(uGradient,vec2(0.5)).r',expected:0.5,tolerance:0.005}, {name:'uCurve',expression:'texture(uCurve,vec2(0.75,0.5)).r',expected:0.5,tolerance:0.005});
    declarations.push(`uniform int uProbe; // @range 0 ${cases.length-1} @default 0`);
    const fragment='void mainImage(out vec4 c,in vec2 p){float value=0.0;'+cases.map((item,i)=>`if(uProbe==${i}) value=${item.expression};`).join('\n')+'c=vec4(value);}';
    check(studio.setProject({common:declarations.join('\n'),image:'void mainImage(out vec4 c,in vec2 p){c=vec4(0.0);}',passes:[{name:'A',format:'rgba32f',size:[1,1],scale:1,filter:'nearest',fragment,channels:{}}],imageChannels:{}}),'모든 타입의 Common 어노테이션과 버퍼 셰이더 컴파일');
    const registered=r.getUserUniforms();
    for(const item of cases.filter(item=>item.type)) {
      const actual=registered.find(user=>user.name===item.name);
      check(actual?.type===item.type&&JSON.stringify(actual.value)===JSON.stringify(item.values.length===1?item.values[0]:item.values),`${item.type}: 기본값과 원소 순서`);
    }
    r.beginOffline({width:2,height:2});offline=true;
    for(let i=0;i<cases.length;i++) {
      const item=cases[i];r.setUniform('uProbe',i);r.renderOfflineFrame({time:0,delta:0,frame:i});
      let actual=r.readPassPixel('A',0,0)[0];
      check(Math.abs(actual-item.expected)<=item.tolerance,`${item.type||item.name}: GPU 기본값 ${actual}`);
      if(!item.type)continue;
      const values=item.values.map(value=>typeof value==='boolean'?!value:value+1);
      r.setUniform(item.name,values.length===1?values[0]:values);
      r.renderOfflineFrame({time:0,delta:0,frame:i});actual=r.readPassPixel('A',0,0)[0];
      const expected=values.reduce((sum,value,j)=>sum+Number(value)*(j+1),0);
      check(Math.abs(actual-expected)<=item.tolerance,`${item.type}: 값 변경이 GPU에 전달`);
    }
  } finally {
    if(offline)r.endOffline();settings.setLinks([]);studio.setProject(old);r.setUserUniforms(users);settings.setLinks(links);
    document.dispatchEvent(new Event('shader-settings-applied'));
  }
})();
