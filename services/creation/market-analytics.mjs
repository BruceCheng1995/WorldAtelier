import {hash} from './schema.mjs';

const DAY=86400000;
/** Aggregate traffic only; no IPs, login tokens or visitor fingerprints. */
export class MarketAnalytics {
  constructor(store){
    this.store=store;
    if(!store.get('market_analytics_meta','singleton'))store.put('market_analytics_meta',{id:'singleton',started_at:Date.now()});
    this.reconcile();
  }
  record(assetId,kind,at=Date.now()){
    const row=this.store.get('market_metric',assetId)??{id:assetId,downloads:0,views:0,file_downloads:0,days:{}};
    const day=Math.floor(at/DAY),bucket=row.days[day]??={views:0,downloads:0,file_downloads:0};
    row[kind]++;bucket[kind]++;row.last_activity_at=at;
    for(const key of Object.keys(row.days))if(Number(key)<Math.floor(Date.now()/DAY)-6)delete row.days[key];
    this.store.put('market_metric',row);
  }
  stats(assetId,at=Date.now()){
    const row=this.store.get('market_metric',assetId),cutoff=Math.floor(at/DAY)-6;
    const recent=Object.entries(row?.days??{}).filter(([day])=>Number(day)>=cutoff).map(([,value])=>value);
    const views_7d=recent.reduce((n,v)=>n+v.views,0),imports_7d=recent.reduce((n,v)=>n+v.downloads,0);
    return {downloads:row?.downloads??0,views:row?.views??0,file_downloads:row?.file_downloads??0,views_7d,imports_7d,heat_7d:views_7d+5*imports_7d,last_activity_at:row?.last_activity_at??null};
  }
  complete(intent){
    const receipt=this.store.get('creator_receipt',intent.receipt_id);
    if(!receipt||receipt.fingerprint!==intent.fingerprint)return false;
    return this.store.transaction(()=>{
      if(this.store.get('market_import_counted',intent.id))return false;
      const at=this.store.get('creator_revision',receipt.result.revision)?.created_at??Date.now();
      this.record(intent.asset_id,'downloads',at);
      this.store.put('market_import_counted',{id:intent.id,asset_id:intent.asset_id,at});
      this.store.remove('market_import_pending',intent.id);return true;
    });
  }
  prepare(user,branch,prepared,origin){
    const receipt_id=`${branch.id}:${prepared.transaction.transaction_id}`,id=hash(receipt_id);
    const intent={id,receipt_id,asset_id:prepared.import.asset_id,fingerprint:hash({user_id:user.id,input:prepared.transaction,origin})};
    if(!this.store.get('market_import_counted',id))this.store.put('market_import_pending',intent);
    return intent;
  }
  reconcile(){for(const intent of this.store.list('market_import_pending')){this.complete(intent);this.store.remove('market_import_pending',intent.id);}}
}
