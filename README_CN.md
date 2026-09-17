# StoryGen Atelier
[English](README_EN.md) | [中文](README_CN.md)

AI 辅助的分镜与视频生成工具。使用 Gemini 生成分镜文本与帧图，利用 Vertex AI Veo 生成过渡片段并拼接成全片，内置日志与画廊管理。

![All Styles](exampleImg/all.png)

## 功能
- **分镜生成**：Gemini 文本模型生成分镜脚本，Gemini 图像模型生成每帧图；支持自定义风格和镜头数。
- **视频生成**：基于分镜的插帧链（Interpolation Chain），调用 Vertex Veo 生成片段并用 ffmpeg 拼接成整片。
- **日志面板**：视频日志 + 分镜日志（SQLite 持久化），支持查看/导出/清空。
- **画廊**：保存、载入、删除已生成的分镜 + 视频。
- **提示指南**：内置 `guide/VideoGenerationPromptGuide.md` 供模型提示参考。

## 核心技术：视频生成与拼接算法
本项目采用 **"插值链" (Interpolation Chain / Sliding Window)** 策略，将静态的分镜图片转化为连贯的视频故事。该过程完全自动化，主要包含以下三个阶段：

### 1. 过渡分析 (Transition Analysis) - Gemini
系统首先遍历分镜列表，使用滑动窗口处理每一对相邻镜头（Shot A → Shot B）。
- **智能分析**：调用 **Gemini** 模型分析 Shot A 和 Shot B 的视觉内容。
- **生成指令**：Gemini 输出一段特定的 **过渡提示词 (Transition Prompt)** 和建议的 **持续时间**，详细描述如何从第一个画面平滑运镜过渡到第二个画面（例如："Slow dolly zoom in while panning right..."）。

### 2. 独立片段生成 (Clip Generation) - Vertex AI Veo
基于第一步的分析结果，并行调用 **Vertex AI (Veo 模型)** 生成视频片段。
- **中间过渡**：对于每一对镜头 (A, B)，将 Gemini 生成的提示词 + Shot A (起始帧) + Shot B (结束帧) 发送给 Veo，生成一段连接两者的视频片段。
- **结尾**：对于最后一个镜头 (Shot N)，系统会单独生成一个 "Closing Shot" 片段（通常为 4-12秒），通过 "Hold on the final frame with a gentle cinematic finish" 等提示词，让故事有一个优雅的静止或微动结尾。

### 3. 最终拼接 (Final Assembly) - FFmpeg
当所有片段（过渡片段 + 结尾片段）生成完毕后，后端使用 **FFmpeg** 进行无损拼接。
- **序列组合**：将所有生成的 `.mp4` 片段按时间顺序写入列表。
- **流式拷贝**：使用 `concat` 协议和 copy 模式 (`-c copy`) 快速合并视频流，避免二次编码导致的画质损失，最终输出完整的 `full_story_xxx.mp4` 文件。

## 技术栈
- **前端**: React, Vite, Mantine UI (组件库)
- **后端**: Node.js (Express), better-sqlite3 (高性能数据存储), fluent-ffmpeg (视频拼接)
- **AI 服务**: Google Gemini (文本/图像), Google Vertex AI Veo (视频生成)

## 目录结构
```
backend/    Node.js + Express API，调用 Gemini/Vertex，管理日志与数据
frontend/   React + Vite + Mantine UI
guide/      提示词指南
exampleImg/ README 用的示例分镜帧图（从本地数据导出）
backend.log / frontend.log 运行期日志
```

## 运行要求
- Node.js 18+，npm
- ffmpeg
- **Google Cloud 项目**：必须启用 **Vertex AI API**（Veo 模型用于视频生成）
- **Gemini API Key**：用于分镜脚本与图像生成
- **MiniMax API Key（可选）**：配置后文本 / 帧图 / 片段可改走 MiniMax-M3 / image-01 / MiniMax-H3

## 环境变量
在 `backend/.env`（可复制 `.env.example`）配置：
```
PORT=3005
GEMINI_API_KEY=你的_gemini_api_key
GEMINI_TEXT_MODEL=gemini-3-pro-preview
GEMINI_IMAGE_MODEL=gemini-3-pro-image-preview
# Vertex AI (视频生成必须配置)
VERTEX_PROJECT_ID=你的_gcp_project_id
VERTEX_LOCATION=us-central1
VERTEX_VEO_MODEL=veo-3.1-generate-preview

# MiniMax（可选：文本 / 图像 / 视频）
MINIMAX_API_KEY=
MINIMAX_API_REGION=global_en   # global_en -> api.minimax.io，cn_zh -> api.minimaxi.com
LLM_PROVIDER=                  # 设为 "minimax" 时，分镜与转场文本走 MiniMax-M3
MINIMAX_TEXT_MODEL=MiniMax-M3
IMAGE_PROVIDER=                # 设为 "minimax" 时，分镜帧图走 image-01
MINIMAX_IMAGE_MODEL=image-01
VIDEO_PROVIDER=                # 设为 "minimax" 时，视频片段走 MiniMax-H3（替代 Vertex Veo）
MINIMAX_VIDEO_MODEL=MiniMax-H3
MINIMAX_VIDEO_RESOLUTION=2K
```

MiniMax 为可选路径：三个 PROVIDER 变量留空即沿用 Gemini/Vertex；图像与视频在配置 `MINIMAX_API_KEY` 后会自动切换。其余变量（M3 思考开关、区域/host 覆盖、时长与比例、回调地址等）见 `backend/.env.example`。

## 快速启动 (推荐)
无需分别启动前后端，直接在根目录运行：
```bash
# 赋予执行权限（仅需一次）
chmod +x start_servers.sh
# 启动服务
./start_servers.sh
```
脚本将自动：
1. 在端口 **3005** 启动后端 API
2. 在端口 **5180** 启动前端界面
3. 将日志分别输出到 `backend.log` 和 `frontend.log`

## 手动安装与启动
后端：
```bash
cd backend
npm install
cp .env.example .env  # 并填入真实 key
npm run dev           # 或 npm start
```
前端（默认 5180 端口）：
```bash
cd frontend
npm install
npm run dev
```
打包：
```bash
cd frontend && npm run build
```

## 示例
- 分镜风格示例：
  - 动漫风格示例：![Anime](exampleImg/Anime.png)

https://github.com/user-attachments/assets/a70279b0-80f7-4b9a-96fb-173e5912d43a

 - <img width="1198" height="1242" alt="image" src="https://github.com/user-attachments/assets/f78a1b54-2490-4d51-80c9-6bb8d41b0b49" />

https://github.com/user-attachments/assets/66bbe81e-34f1-44dd-b648-2a8cb84e5eba
  
  - 赛博朋克示例：![Cyberpunk](exampleImg/Cyberpunk.png)
  - 
https://github.com/user-attachments/assets/ad56e3c8-c14e-48fb-8366-ad22c4e8ea60

  - 吉卜力风示例：![Ghibli Style](exampleImg/GhibliStyle.png)
  - 
https://github.com/user-attachments/assets/fe6c57fa-0bb5-4c81-8efb-1c7c52011948

  - 写实示例：![Realism](exampleImg/Realism.png)
  - 
https://github.com/user-attachments/assets/2ca41cbf-2765-4e6b-8e85-8ba0e8e191f5

  - 国风水墨示例：![Chinese Ink](exampleImg/ChineseInk.png)
  - 
https://github.com/user-attachments/assets/99305353-a348-45ca-add7-f9692bccdc95
    
