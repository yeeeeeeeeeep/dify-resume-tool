const express = require('express');
const cors = require('cors');
const formidable = require('formidable');
const axios = require('axios');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.static('.'));

const DIFY_API_URL = process.env.DIFY_API_URL;
const DIFY_API_KEY = process.env.DIFY_API_KEY;

const getVal = (v) => Array.isArray(v) ? v[0] : v;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/api/run-workflow', async (req, res) => {
  const form = formidable({});

  form.parse(req, async (err, fields, files) => {
    if (err) {
      console.error('表单解析错误：', err);
      return res.status(500).json({ error: '表单解析失败' });
    }

    try {
      const inputData = {
        JL: getVal(fields.JL ?? ''),
        JD: getVal(fields.JD ?? ''),
        JD_lianjie: getVal(fields.JD_lianjie ?? ''),
        JL_output_type: getVal(fields.JL_output_type ?? ''),
        JD_name: getVal(fields.JD_name ?? ''),
        JL_example: getVal(fields.JL_example ?? '')
      };

      console.log('后端收到表单字段：', inputData);

      if (!DIFY_API_URL || !DIFY_API_KEY) {
        return res.status(500).json({
          error: '环境变量缺失，请检查 DIFY_API_URL 和 DIFY_API_KEY'
        });
      }

      const resp = await axios.post(
        `${DIFY_API_URL}/workflows/run`,
        {
          inputs: inputData,
          response_mode: 'blocking',
          user: 'resume-tool-user'
        },
        {
          headers: {
            'Authorization': `Bearer ${DIFY_API_KEY}`,
            'Content-Type': 'application/json'
          }
        }
      );

      res.json(resp.data);
    } catch (e) {
      console.error('请求 Dify 报错：', e.response?.data || e.message);
      res.status(500).json({
        error: e.message,
        detail: e.response?.data
      });
    }
  });
});

app.listen(port, () => {
  console.log(`服务启动成功，端口 ${port}`);
});
