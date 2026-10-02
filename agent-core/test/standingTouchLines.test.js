import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import { migrateStandingInteractions } from '../src/db/standingInteractionSchema.js';
import { TOUCH_PARTS, buildTouchLineMessages, parseTouchLines, readTouchLines, startTouchLines, saveTouchLines, fillMissingTouchLines, hasTouchLines } from '../src/services/standingTouchLines.js';
const valid=()=>({lines:Object.fromEntries(Object.keys(TOUCH_PARTS).map(k=>[k,['第一句测试台词。','第二句测试台词。','第三句测试台词。']]))});
function fixture(t){const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');db.exec('CREATE TABLE characters(id INTEGER PRIMARY KEY);INSERT INTO characters VALUES(1);INSERT INTO characters VALUES(2);');migrateStandingInteractions(db);return db;}
test('one complete JSON example and tolerant JSON normalization',()=>{
 assert.deepEqual(Object.keys(parseTouchLines(JSON.stringify(valid()))),Object.keys(TOUCH_PARTS));
 const prompt=buildTouchLineMessages({display_name:'测试',base_prompt:'谨慎温柔'},{systemRules:'规则与世界观',worldRule:'世界观强化'});
 assert.deepEqual(prompt.map(m=>m.role),['system','system','system','system','user']);
 assert.equal(prompt[0].content,'规则与世界观');assert.equal(prompt[1].content,'世界观强化');assert.match(prompt[3].content,/谨慎温柔/);
 for(const key of Object.keys(TOUCH_PARTS))assert.ok(prompt[2].content.includes(`"${key}"`));
 for(const mutate of [v=>delete v.lines.head,v=>v.lines.face.push('多余的第四句'),v=>v.lines.face[0]='短',v=>v.lines.face[1]=v.lines.face[0],v=>v.lines.face[0]='带有\n换行台词',v=>v.extra=true]){const v=valid();mutate(v);assert.doesNotThrow(()=>parseTouchLines(v));}
});
test('manual line edits validate and reject stale or generating versions',async t=>{
 const db=fixture(t),events=[];
 const first=saveTouchLines({db,id:1,lines:valid().lines,expectedVersion:null,emit:(...e)=>events.push(e)});
 assert.equal(first.status,'ready');assert.ok(first.version);assert.equal(events.length,1);
 assert.throws(()=>saveTouchLines({db,id:1,lines:valid().lines,expectedVersion:null}),{status:409});
 assert.throws(()=>parseTouchLines("{broken"),SyntaxError);
 const updated=valid().lines;updated.head[0]='这里是手动修改的台词。';
 const second=saveTouchLines({db,id:1,lines:updated,expectedVersion:first.version});
 assert.notEqual(second.version,first.version);assert.equal(readTouchLines(db,1).lines.head[0],updated.head[0]);
 db.prepare("UPDATE character_standing_touch_lines SET status='generating' WHERE character_id=1").run();
 assert.throws(()=>saveTouchLines({db,id:1,lines:updated,expectedVersion:second.version}),{status:409});
 assert.throws(()=>saveTouchLines({db,id:99,lines:updated,expectedVersion:null}),{status:404});
});
test('background task deduplicates in-flight work and preserves old lines on failure',async t=>{
 const db=fixture(t),character={id:1};let release,calls=0;
 await startTouchLines({db,character,generate:async()=>valid()});
 const first=readTouchLines(db,1).lines;
 const task=startTouchLines({db,character,generate:()=>{calls++;return new Promise(r=>release=r)}});
 assert.equal(readTouchLines(db,1).status,'generating');
 assert.equal(startTouchLines({db,character,generate:()=>assert.fail('duplicate call')}),null);
 await Promise.resolve();assert.equal(calls,1);release("{broken");await task;
 assert.equal(readTouchLines(db,1).status,'failed');assert.deepEqual(readTouchLines(db,1).lines,first);
 assert.equal(readTouchLines(db,2).status,'empty');
 await startTouchLines({db,character,generate:async()=>valid()});assert.equal(readTouchLines(db,1).status,'ready');
});
test('late results never resurrect deleted characters or overwrite a newer request',async t=>{
 const db=fixture(t);let release;
 const task=startTouchLines({db,character:{id:1},generate:()=>new Promise(r=>release=r)});
 await Promise.resolve();db.prepare("UPDATE character_standing_touch_lines SET request_id='newer',status='failed' WHERE character_id=1").run();release(valid());await task;
 assert.equal(readTouchLines(db,1).status,'failed');assert.equal(readTouchLines(db,1).lines,null);
 const deleted=startTouchLines({db,character:{id:2},generate:()=>new Promise(r=>release=r)});
 await Promise.resolve();db.prepare('DELETE FROM characters WHERE id=2').run();release(valid());await deleted;
 assert.equal(readTouchLines(db,2).status,'empty');
});
test('restart recovers interrupted status without discarding saved dialogue',async t=>{
 const db=fixture(t);await startTouchLines({db,character:{id:1},generate:async()=>valid()});
 db.prepare("UPDATE character_standing_touch_lines SET status='generating' WHERE character_id=1").run();migrateStandingInteractions(db);
 assert.equal(readTouchLines(db,1).status,'failed');assert.ok(readTouchLines(db,1).lines.head);
});

test('legacy neck and shoulder sets remain readable as ten parts',t=>{
 const db=fixture(t),lines=valid().lines;lines.neck=['颈部旧台词一。','颈部旧台词二。','颈部旧台词三。'];
 db.prepare("INSERT INTO character_standing_touch_lines(character_id,request_id,status,lines_json) VALUES(1,'legacy','ready',?)").run(JSON.stringify(lines));
 const current=readTouchLines(db,1);assert.equal(Object.keys(current.lines).length,10);assert.equal(current.lines.neck,undefined);assert.deepEqual(current.lines.shoulder,lines.shoulder);
});

test('prompt pins merged shoulder key and parser identifies malformed fields',()=>{
 const task=buildTouchLineMessages({name:'测试'})[2].content;
 assert.match(task,/共 10 组、30 句/);assert.match(task,/统一写 shoulder/);
 const example=JSON.parse(task.slice(task.indexOf('{')));
 assert.deepEqual(Object.keys(example.lines),Object.keys(TOUCH_PARTS));
 assert.ok(Object.values(example.lines).every(lines=>lines.length===3));
 const value=valid();value.lines.neck_shoulder=value.lines.shoulder;delete value.lines.shoulder;
 assert.deepEqual(parseTouchLines(value).shoulder,[]);
});

test('relationship context stays in final user message and preserves zero affinity',()=>{
 const messages=buildTouchLineMessages({name:'测试',base_prompt:'角色人格'},{userName:'小林',relationship:{relationship_text:'朋友',affinity:0,is_oath:1}});
 assert.equal(messages.length,5);assert.match(messages[4].content,/按照 <world_setting> 中的世界观设定设计台词/);assert.match(messages[4].content,/用户称呼：小林/);assert.match(messages[4].content,/角色是用户的：朋友/);assert.match(messages[4].content,/好感度：0\/100/);assert.match(messages[4].content,/已誓约/);
 const fallback=buildTouchLineMessages({name:'测试'})[4].content;assert.match(fallback,/尚未设定关系/);assert.match(fallback,/50\/100/);
});

test('variable relationship data leaves the system prefix unchanged',()=>{
 const character={name:'测试',base_prompt:'固定人格'};
 const first=buildTouchLineMessages(character,{relationship:{affinity:0}});
 const next=buildTouchLineMessages(character,{relationship:{affinity:99}});
 assert.deepEqual(first.slice(0,4),next.slice(0,4));assert.notEqual(first[4].content,next[4].content);
 assert.equal(first[0].content,buildTouchLineMessages({name:'其他角色'})[0].content);
});

test('valid JSON accepts long, duplicate and variable-length lines',()=>{
 const long='长'.repeat(80);
 assert.deepEqual(parseTouchLines(JSON.stringify({lines:{face:['嗯',long,'嗯','换行\n台词',null],head:'你好'}})).face,['嗯',long,'嗯','换行\n台词']);
 for(const value of ['null','[]','42','{}'])assert.doesNotThrow(()=>parseTouchLines(value));
});

test('bulk fill skips existing dialogue and in-flight tasks without duplicate calls',async t=>{
 const db=fixture(t);await startTouchLines({db,character:{id:1},generate:async()=>valid()});
 const before=readTouchLines(db,1);let calls=0,release;
 const generate=()=>{calls++;return new Promise(resolve=>release=resolve)};
 assert.deepEqual(fillMissingTouchLines({db,generate}),{started:1,skipped:1});
 assert.deepEqual(fillMissingTouchLines({db,generate}),{started:0,skipped:2});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);
 release(valid());await new Promise(resolve=>setImmediate(resolve));
 assert.equal(hasTouchLines(readTouchLines(db,2)),true);assert.deepEqual(readTouchLines(db,1),before);
 assert.equal(hasTouchLines({lines:{face:[]}}),false);
});
