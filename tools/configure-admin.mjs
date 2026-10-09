import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';

// Local operator command, deliberately absent from HTTP and Agent tools.
const args=process.argv.slice(2),option=key=>{const i=args.indexOf(key);return i<0?null:args[i+1];};
const uid=option('--user-id'),data=resolve(option('--data')??process.env.WORLD_ATELIER_CREATION_DATA??'.local/model-preview/creation');
if(!uid||!/^user-[a-zA-Z0-9-]+$/.test(uid))throw new Error('用法：node tools/configure-admin.mjs --user-id <已核实的账号 UUID> [--data <创作数据目录>]');
const db=new DatabaseSync(resolve(data,'creation.sqlite'));
try{
  db.exec('BEGIN IMMEDIATE');
  const read=(kind,key)=>{const row=db.prepare('SELECT body FROM documents WHERE kind=? AND id=?').get(kind,key);return row?JSON.parse(row.body):null;};
  const user=read('creator_user',uid);if(!user||user.disabled_at)throw new Error('目标必须为已存在且未停用的账号');
  const old=read('creator_admin_settings','singleton');
  if(old&&old.owner_user_id!==uid)throw new Error('已有唯一管理员。此命令不提供隐式转让；须另行明确处理。');
  const row={id:'singleton',owner_user_id:uid,configured_at:old?.configured_at??Date.now()};
  db.prepare('INSERT INTO documents(kind,id,body) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET body=excluded.body').run('creator_admin_settings',row.id,JSON.stringify(row));
  db.exec('COMMIT');console.log(`唯一管理员已绑定：${user.name} (${uid})`);
}catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
