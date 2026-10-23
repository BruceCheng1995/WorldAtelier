import {hostname, networkInterfaces} from 'node:os';

/** IPv4-mapped literals reach the same listener without DNS or another port,
 * but retain a different browser host/origin and host-only cookie namespace. */
export function mappedRuntimeOrigin(origin, address) {
  const source=new URL(origin),parts=String(address).split('.');
  if(source.protocol!=='http:'||parts.length!==4||parts.some(p=>!/^\d{1,3}$/.test(p)||Number(p)>255))throw Error('运行地址需要明确的本机 IPv4 地址');
  return new URL(`http://[::ffff:${parts.map(Number).join('.')}]:${source.port||80}`).origin;
}

export function workspaceNetwork(port, env=process.env) {
  // Alternate ports remain private unless an isolated test explicitly opts in.
  const lan=env.WORLD_ATELIER_LAN===undefined?port===48910:env.WORLD_ATELIER_LAN==='1';
  const publicPlay=env.WORLD_ATELIER_PUBLIC_PLAY===undefined?port===48910:env.WORLD_ATELIER_PUBLIC_PLAY==='1';
  const addresses=()=>Object.entries(networkInterfaces()).filter(([name])=>! /^(utun|tun|tap)/.test(name)).flatMap(([,rows])=>rows.filter(row=>!row.internal&&row.family==='IPv4').map(row=>row.address));
  const hosts=()=>new Set(['127.0.0.1','localhost','[::1]',...(lan?[hostname().toLowerCase(),...addresses()]:[])]);
  const requestOrigin=req=>{
    try {
      const authority=req.headers.host;
      if(typeof authority!=='string'||/[\s/@?#\\]/.test(authority))return null;
      const url=new URL(`http://${authority}`);
      if(Number(url.port||80)!==port||!hosts().has(url.hostname.toLowerCase()))return null;
      return url.origin;
    } catch {return null;}
  };
  const runtimeAddresses=()=>['127.0.0.1',...(lan?addresses():[])];
  const loopbackRuntime=`http://wa-runtime.localhost:${port}`;
  const runtimeOrigins=()=>new Set([loopbackRuntime,...runtimeAddresses().map(address=>mappedRuntimeOrigin(`http://127.0.0.1:${port}`,address))]);
  const runtimeRequestOrigin=req=>{
    try{
      const authority=req.headers.host;if(typeof authority!=='string'||/[\s/@?#\\]/.test(authority))return null;
      const origin=new URL(`http://${authority}`).origin;return runtimeOrigins().has(origin)?origin:null;
    }catch{return null;}
  };
  const runtimeOriginFor=req=>{
    const origin=requestOrigin(req);if(!origin)throw Error('运行授权必须来自创作工作台');
    const host=new URL(origin).hostname;
    const address=['localhost','127.0.0.1','[::1]'].includes(host)?'127.0.0.1':runtimeAddresses().includes(host)?host:String(req.socket?.localAddress??'').replace(/^::ffff:/,'');
    if(!runtimeAddresses().includes(address))throw Error('无法确定当前连接的隔离运行地址');
    return address==='127.0.0.1'?loopbackRuntime:mappedRuntimeOrigin(origin,address);
  };
  return {lan,publicPlay,host:lan?'0.0.0.0':'127.0.0.1',requestOrigin,runtimeRequestOrigin,runtimeOriginFor,
    urls:()=>[...new Set(['127.0.0.1',...(lan?addresses():[])])].map(host=>`http://${host}:${port}/creation-workspace.html`)};
}
