const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// 托管前端页面
app.use(express.static('.'));

const DIFY_API_URL = process.env.DIFY_API_URL;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

app.post('/api/run-workflow', async (req, res) => {
  try {
    // 和前端表单传过来的字段对应
    const { JL, JD, JD_fenjie, JL_output_type, JD_name, JL_example } = req.body;
    if(!DIFY_API_URL || !DIFY_API_KEY) {
      return res.status(500).json({error: "环境变量缺失，请检查Dify密钥和地址"});
    }
    const resp = await axios.post(`${DIFY_API_URL}/workflows/run`,{
      inputs:{
        JL: JL,
        JD: JD,
        JD_fenjie: JD_fenjie,
        JL_output_type: JL_output_type,
        JD_name: JD_name,
        JL_example: JL_example
      },
      response_mode: "blocking",
      user: "resume-tool-user"
    },{
      headers:{
        "Authorization": `Bearer ${DIFY_API_KEY}`,
        "Content-Type":"application/json"
      }
    })
    res.json(resp.data);
  } catch(e){
    console.error("请求Dify报错：", e.response?.data || e.message);
    res.status(500).json({error: e.message, detail: e.response?.data})
  }
})

app.listen(port, ()=>{
  console.log(`服务启动成功，端口 ${port}`);
})
