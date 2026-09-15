const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const {execFileSync}=require('node:child_process')
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex')
function safeUrl(value){
 try{const u=new URL(value);return u.origin+u.pathname}catch{return '<unavailable-url>'}
}
function sourceSnapshot(root){
 const names=execFileSync('git',['ls-files','-z','--cached','--others','--exclude-standard'],{cwd:root,encoding:'utf8'}).split('\0')
 const files=[...new Set(names)].filter(p=>/^(src\/|scripts\/|examples\/|tests\/|package(?:-lock)?\.json$)/.test(p)&&!p.startsWith('tests/rendering/baselines/')&&p!=='tests/rendering/stage1-baseline.json')
  .sort().filter(p=>fs.existsSync(path.join(root,p))&&fs.statSync(path.join(root,p)).isFile())
  .map(p=>({path:p,sha256:sha(fs.readFileSync(path.join(root,p)))}))
 let head=null
 try{head=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim()}catch{}
 return {head,files,contentHash:sha(JSON.stringify(files))}
}
function compareGolden(expected,actual){
 assert.deepEqual({target:actual.target,configuration:actual.configuration,captures:actual.captures},
  {target:expected.target,configuration:expected.configuration,captures:expected.captures},'baseline mismatch')
}
function assertRequests(requests){
 assert.deepEqual(requests.httpErrors,[],'required resource HTTP failure')
 assert.deepEqual(requests.failed,[],'required resource request failure')
 assert.deepEqual(requests.providerErrors,[],'imagery provider resource failure')
}
module.exports={safeUrl,sourceSnapshot,compareGolden,assertRequests}
