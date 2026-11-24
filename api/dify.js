export default async function handler(req, res) {
  // 只允许POST请求
  if(req.method !== "POST"){
    return res.status(405).json({error:"仅支持POST请求"})
  }
  const DIFY_API_KEY = process.env.DIFY_API_KEY;
  const DIFY_BASE_URL = process.env.DIFY_BASE_URL;
  if(!DIFY_API_KEY || !DIFY_BASE_URL){
    return res.status(500).json({error:"环境变量未配置"})
  }
  const {jd, resume} = req.body;
  try{
    const difyResp = await fetch(`${DIFY_BASE_URL}/workflows/run`,{
      method:"POST",
      headers:{
        "Authorization":`Bearer ${DIFY_API_KEY}`,
        "Content-Type":"application/json"
      },
      body:JSON.stringify({
        inputs:{
          jd: jd,
          resume: resume
        },
        response_mode:"stream",
        user:"user-001"
      })
    })
    // 这里简化：先拿完整结果（流式版本后面再升级）
    const raw = await difyResp.json();
    if(raw.error){
      return res.status(400).json({error:raw.error.message || raw.error})
    }
    return res.json({answer:raw.data.outputs?.text || JSON.stringify(raw.data.outputs)})
  }catch(err){
    return res.status(500).json({error:err.message})
  }
}
