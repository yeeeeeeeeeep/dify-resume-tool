const express = require('express');
const cors = require('cors');
const axios = require('axios');
const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
// 托管前端页面，访问网址直接打开求职助手表单
app.use(express.static('.'));

const DIFY_API_URL = process.env.DIFY_API_URL;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

app.post('/api/run-workflow', async (req, res) => {
  try {
    const { job, company, direction, resume } = req.body;
    if(!DIFY_API_URL || !DIFY_API_KEY) {
      return res.status(500).json({error: "环境变量缺失"});
    }
    const resp = await axios.post(`${DIFY_API_URL}/workflows/run`,{
      inputs:{
        job: job,
        company: company,
        direction: direction,
        resume: resume
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
    console.error(e.response?.data || e.message);
    res.status(500).json({error: e.message});
  }
})

app.listen(port, ()=>{
  console.log(`服务启动，端口 ${port}`);
})
