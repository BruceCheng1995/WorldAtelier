import {mountAssetMarket} from './asset-market.js';
import {CreationClient} from './collaboration-client.js';
const api=new CreationClient();
mountAssetMarket(document.querySelector('#marketRoot'),{api,initialQuery:Object.fromEntries(new URL(location.href).searchParams),assetId:location.pathname.split('/')[3],version:new URL(location.href).searchParams.get('version')});
