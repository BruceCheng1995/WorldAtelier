const port=Number(process.env.WORLD_ATELIER_PREVIEW_PORT??48910);
try{
  const values=await Promise.all(['preview-api/health','creation-api/health'].map(async path=>{
    const response=await fetch(`http://127.0.0.1:${port}/${path}`,{signal:AbortSignal.timeout(3000)});
    if(!response.ok)throw Error(`${path}: ${response.status}`);return response.json();
  }));
  if(!values.every(value=>value.ok)||!values[0].runtime_ready||!values[1].default_projects?.count)throw Error('视口或默认工程尚未就绪');
}catch(error){console.error(error.message);process.exitCode=1;}
