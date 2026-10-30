import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {PGlite} from '@electric-sql/pglite';

// Explicit opt-in and a dedicated database name. Every fixture gets its own schema.
export async function testDatabase({persistentDirectory=null}={}) {
  const connectionString=process.env.TEST_DATABASE_URL;
  if(!connectionString) return new PGlite(persistentDirectory || undefined);
  const url=new URL(connectionString);
  if(process.env.EXAMOS_TEST_DATABASE_DISPOSABLE!=='1' || !/^\/examos_test(?:_|$)/.test(url.pathname))
    throw Error('Native tests require EXAMOS_TEST_DATABASE_DISPOSABLE=1 and a dedicated examos_test database');
  if(persistentDirectory) throw Error('Persistent PGlite hardware fixtures must not use TEST_DATABASE_URL');
  const schema='examos_fixture_'+randomUUID().replaceAll('-','');
  const admin=new pg.Pool({connectionString,max:1});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db=new pg.Pool({connectionString,options:`-c search_path=${schema}`,max:8});
  let closed=false;
  db.close=async()=>{
    if(closed)return;closed=true;
    try{await db.end();await admin.query(`DROP SCHEMA "${schema}" CASCADE`)}finally{await admin.end()}
  };
  return db;
}
