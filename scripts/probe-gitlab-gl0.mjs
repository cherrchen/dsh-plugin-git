#!/usr/bin/env node
/** GL0 server evidence only. Fixed loopback routing, explicit per-request trust, synthetic fixtures. */
import https from 'node:https';
import assert from 'node:assert/strict';
import { readFile, writeFile, access } from 'node:fs/promises';
const dir=process.argv[2];
assert(dir?.startsWith('/')&&dir.endsWith('/'),'Pass an absolute isolated fixture directory ending in /');
const secrets=JSON.parse(await readFile(dir+'config/b4-secrets.json'));
const ca=await readFile(dir+'config/ssl/gitlab-b4.test.crt');
const prefix=process.argv[3]??'';
assert(prefix===''||prefix==='/gitlab','Only the two isolated fixture lanes are allowed');
const checks=[];const gaps=[];
async function request(method,path,body,token=secrets.fixtureToken){
 const data=body?JSON.stringify(body):undefined;
 return new Promise((resolve,reject)=>{const req=https.request({hostname:'gitlab-b4.test',port:18443,path:prefix+path,method,ca,lookup:(h,o,cb)=>cb(null,o.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4),headers:{...(token?{Authorization:'Bearer '+token}:{}),...(data?{'Content-Type':'application/json','Content-Length':Buffer.byteLength(data)}:{})}},res=>{const tlsAuthorized=res.socket.authorized;let text='';res.on('data',c=>text+=c);res.on('end',()=>{let value;try{value=JSON.parse(text)}catch{value=null}resolve({status:res.statusCode,value,headers:res.headers,tlsAuthorized})})});req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('request timeout')));req.end(data)});
}
function ok(r,status,label){assert.equal(r.status,status,label+' status');assert(r.tlsAuthorized,'TLS validation required');checks.push(label);return r.value}
const metadata=ok(await request('GET','/api/v4/metadata'),200,'authenticated-metadata');
assert.equal(metadata.version,'19.5.1-ee');
ok(await request('GET','/api/v4/user'),200,'authenticated-user');
const device=ok(await request('POST','/oauth/authorize_device',{client_id:secrets.clientId,scope:'api'},null),200,'public-app-device-initialization');
assert.equal(device.verification_uri,`https://gitlab-b4.test:18443${prefix}/oauth/device`);
assert(device.expires_in>0&&device.interval>0);
const pending=await request('POST','/oauth/token',{client_id:secrets.clientId,device_code:device.device_code,grant_type:'urn:ietf:params:oauth:grant-type:device_code'},null);
assert.equal(pending.value?.error,'authorization_pending');checks.push('device-token-pending-without-api-bearer');
let fixture;
const exists=await access(dir+'fixture.json').then(()=>true,()=>false);
if(!prefix&&!exists){
 const project=ok(await request('POST','/api/v4/projects',{name:'GL0 isolated fixture',path:'gl0-b4-fixture',initialize_with_readme:true,visibility:'private'}),201,'private-project-fixture-created');
 const id=project.id;
 ok(await request('POST',`/api/v4/projects/${id}/repository/branches`,{branch:'gl0-review',ref:project.default_branch}),201,'source-branch-created');
 ok(await request('POST',`/api/v4/projects/${id}/repository/commits`,{branch:'gl0-review',commit_message:'GL0 synthetic fixture',actions:[{action:'create',file_path:'fixture.txt',content:'GL0 synthetic evidence\n'}]}),201,'source-commit-created');
 const mr=ok(await request('POST',`/api/v4/projects/${id}/merge_requests`,{source_branch:'gl0-review',target_branch:project.default_branch,title:'GL0 fixture MR'}),201,'merge-request-created');
 const issue=ok(await request('POST',`/api/v4/projects/${id}/issues`,{title:'GL0 fixture issue'}),201,'issue-fixture-created');
 const user=ok(await request('POST','/api/v4/users',{email:'gl0-reviewer@example.invalid',username:'gl0-reviewer',name:'GL0 Reviewer',reset_password:false,password:'B4-synthetic-fixture-'+crypto.randomUUID(),skip_confirmation:true}),201,'second-user-created');
 ok(await request('POST',`/api/v4/projects/${id}/members`,{user_id:user.id,access_level:30}),201,'reviewer-project-membership');
 const pat=ok(await request('POST',`/api/v4/users/${user.id}/personal_access_tokens`,{name:'isolated reviewer fixture',scopes:['api'],expires_at:new Date(Date.now()+86400000).toISOString().slice(0,10)}),201,'reviewer-fixture-credential');
 fixture={id,iid:mr.iid,issue:issue.iid,sha:mr.sha,path:project.path_with_namespace,reviewerToken:pat.token};
 await writeFile(dir+'fixture.json',JSON.stringify(fixture),{mode:0o600});
}else{fixture=JSON.parse(await readFile(dir+'fixture.json'));}
const {id,iid}=fixture;
const project=ok(await request('GET',`/api/v4/projects/${id}`),200,'project-identity-and-clone-urls');
assert.equal(project.path_with_namespace,fixture.path);
assert.equal(project.http_url_to_repo,`https://gitlab-b4.test:18443${prefix}/${fixture.path}.git`);
assert.equal(project.ssh_url_to_repo,`ssh://git@gitlab-b4.test:18222/${fixture.path}.git`);
checks.push('https-prefix-separated-from-ssh-repository-path');
for(const [path,label] of [[`/projects/${id}/merge_requests`,'mr-list'],[`/projects/${id}/merge_requests/${iid}`,'mr-detail'],[`/projects/${id}/merge_requests/${iid}/commits`,'mr-commits'],[`/projects/${id}/merge_requests/${iid}/diffs`,'mr-diffs'],[`/projects/${id}/merge_requests/${iid}/discussions`,'mr-discussions'],[`/projects/${id}/merge_requests/${iid}/approvals`,'mr-current-approvals'],[`/projects/${id}/issues/${fixture.issue}`,'issue-detail'],['/todos','todos-candidate-source']])ok(await request('GET','/api/v4'+path),200,label);
if(!prefix){
 const note=await request('POST',`/api/v4/projects/${id}/merge_requests/${iid}/notes`,{body:'Synthetic GL0 ordinary note'},fixture.reviewerToken);if(note.status===201)ok(note,201,'reviewer-comment');else gaps.push({check:'reviewer-comment',expected:201,actual:note.status});
 const approve=await request('POST',`/api/v4/projects/${id}/merge_requests/${iid}/approve`,{sha:fixture.sha},fixture.reviewerToken);
 if(approve.status===201)ok(approve,201,'reviewer-sha-approval');else gaps.push({check:'reviewer-sha-approval',expected:201,actual:approve.status});
 const invalid=await request('PUT',`/api/v4/projects/${id}/merge_requests/${iid}/merge`,{sha:'0'.repeat(40)});
 ok(invalid,409,'merge-stale-sha-rejected');
 const anon=await request('GET',`/api/v4/projects/${id}`,undefined,null);
 ok(anon,404,'anonymous-private-project-denied');
}
const evidence={scope:'real isolated server baseline; not plugin acceptance',version:metadata.version,revision:metadata.revision,enterprise:metadata.enterprise,metadataHasPlan:Object.hasOwn(metadata,'plan'),prefix,tls:'certificate validated with per-request trust; no global TLS bypass',checks,gaps,passed:gaps.length===0,limits:['Not GL1/GL5 plugin implementation acceptance.','No licensed-tier, GitLab.com or Windows/Linux/Web/Desktop matrix acceptance.','Device authorization exchange/refresh after browser approval not tested.']};
await writeFile(dir+(prefix?'/prefix-evidence.json':'/baseline-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({version:evidence.version,prefix,checks:checks.length,gaps,passed:evidence.passed}));

if (!evidence.passed) process.exitCode = 1;
