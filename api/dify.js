import { IncomingForm } from 'formidable';

export const config = {
  api: {
    bodyParser: false,
  },
};

// 上传单个文件到Dify，返回file_id
async function uploadFileToDify(file, apiKey, baseUrl) {
  const fs = require('fs');
  const path = require('path');
  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fs.createReadStream(file.filepath), {
    filename: file.originalFilename,
    contentType: file.mimetype
  });
  const resp = await fetch(`${baseUrl}/files/upload`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      ...form.getHeaders()
    },
    body: form
  });
  const resJson = await resp.json();
  if (!resp.ok) throw new Error(resJson.message || '文件上传失败');
  return resJson.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: '仅支持POST请求' });
  }
  const DIFY_API_KEY = process.env.DIFY_API_KEY;
  const DIFY_BASE_URL = process.env.DIFY_BASE_URL;
  if (!DIFY_API_KEY || !DIFY_BASE_URL) {
    return res.status(500).json({ error: '环境变量未配置' });
  }

  // 解析表单（文件+文本）
  const form = new IncomingForm();
  const { fields, files } = await new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) reject(err);
      resolve({ fields, files });
    });
  });

  // 取出文本变量
  const inputData = {
    JD_fanjie: fields.JD_fanjie?.[0] || '',
    JD_name: fields.JD_name?.[0] || '',
    JL_output_type: fields.JL_output_type?.[0] || 'docx'
  };

  // 上传文件到Dify，拿到fileId
  const inputs = {
    JD_fanjie: inputData.JD_fanjie,
    JD_name: inputData.JD_name,
    JL_output_type: inputData.JL_output_type
  };
  try {
    if (files.JL) {
      inputs.JL = await uploadFileToDify(files.JL, DIFY_API_KEY, DIFY_BASE_URL);
    }
    if (files.JD) {
      inputs.JD = await uploadFileToDify(files.JD, DIFY_API_KEY, DIFY_BASE_URL);
    }
    if (files.JL_example) {
      inputs.JL_example = await uploadFileToDify(files.JL_example, DIFY_API_KEY, DIFY_BASE_URL);
    }
  } catch (err) {
    return res.status(400).json({ error: '文件上传Dify失败：' + err.message });
  }

  // 调用Dify工作流
  try {
    const difyResp = await fetch(`${DIFY_BASE_URL}/workflows/run`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DIFY_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        inputs,
        response_mode: 'blocking',
        user: 'resume-user'
      })
    });
    const raw = await difyResp.json();
    if (raw.error) {
      return res.status(400).json({ error: raw.error.message || raw.error });
    }
    const output = raw.data.outputs;
    return res.json({
      text: output.text || '',
      fileUrl: output.files?.[0] || ''
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
