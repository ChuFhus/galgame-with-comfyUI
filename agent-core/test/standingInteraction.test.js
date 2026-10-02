import test from 'node:test';
import assert from 'node:assert/strict';
import Database from 'better-sqlite3';
import {migrateExpressionStandings} from '../src/db/expressionStandingSchema.js';
import {migrateStandingInteractions} from '../src/db/standingInteractionSchema.js';
import {createStandingInteractionService,defaultStandingInteraction} from '../src/services/standingInteractionService.js';
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');
 db.exec('CREATE TABLE characters(id INTEGER PRIMARY KEY,display_name TEXT,is_sleeping INTEGER); CREATE TABLE emoji_categories(id INTEGER PRIMARY KEY,emoji_key TEXT); INSERT INTO characters VALUES(1,\'Test\',0)');
 migrateExpressionStandings(db);migrateStandingInteractions(db);migrateStandingInteractions(db);
 db.prepare('INSERT INTO character_expression_standings(character_id,slot_id,image_url,bounds_json,version) VALUES(1,?,?,?,1)').run('normal','/images/test.png',JSON.stringify({x:0,y:0,width:100,height:200,imageWidth:100,imageHeight:200}));
 const service=createStandingInteractionService({db,imageExists:()=>true});return {db,service};
}
test('configuration is validated, versioned, isolated and cascades on character deletion',t=>{
 const {db,service}=fixture(t),config=defaultStandingInteraction();
 assert.equal(service.get(1).version,0);
 assert.equal(service.save(1,{expectedVersion:0,config}).version,1);
 assert.throws(()=>service.save(1,{expectedVersion:0,config}),{status:409});
 assert.throws(()=>service.save(1,{expectedVersion:1,config:{...config,unknown:true}}),{status:400});
 assert.throws(()=>service.save(1,{expectedVersion:1,config:{...config,bindings:{...config.bindings,pleased:{slotId:'other',imageVersion:1}}}}),{status:409});
 db.prepare('DELETE FROM characters WHERE id=1').run();
 assert.equal(db.prepare('SELECT count(*) n FROM character_standing_interactions').get().n,0);
});
test('image updates invalidate regions and stale saves; a draft survives for reconfirmation',t=>{
 const {db,service}=fixture(t),regions={head:{cx:.5,cy:.2,rx:.1,ry:.05},cheek:null};
 const body={expectedVersion:0,expectedImageVersion:1,regions};
 assert.deepEqual(service.saveRegions(1,'normal',body).slots[0].regions,regions);
 assert.throws(()=>service.saveRegions(1,'normal',body),{status:409});
 db.prepare('UPDATE character_expression_standings SET version=2').run();
 const slot=service.get(1).slots[0];assert.equal(slot.regions,null);assert.deepEqual(slot.regionDraft,regions);
 assert.throws(()=>service.saveRegions(1,'normal',{...body,expectedVersion:1}),{status:409});
 assert.throws(()=>service.saveRegions(1,'normal',{expectedVersion:1,expectedImageVersion:2,regions:{head:{cx:0,cy:0,rx:.3,ry:.3},cheek:null}}),{status:400});
});
