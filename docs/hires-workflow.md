# HiresFix 基础版与进阶版

设置 → HiresFix 细化设置 →「使用进阶 HiresFix 工作流」开关，保存后对后续细化生效。默认关闭，使用基础版；选择保存在数据库，重启后保留。

| 模式 | 文件 | 依赖 |
| --- | --- | --- |
| 基础版（默认） | `workflow/放大细化工作流.json` | 保留原有官方节点流程；沿用已有生图模型，无需额外节点或超分模型 |
| 进阶版 | `workflow/放大细化工作流-进阶.json` | RealESRGAN 超分模型 + Ultimate SD Upscale 节点包 |

基础版原样保留旧图谱：Lanczos → VAEEncode → KSampler → VAEDecode。基础版使用细化步数/CFG，不启用进阶采样继承和原图融合。两套均沿用全局/角色/细化 LoRA 配置，切换不会清空进阶设置；没有进阶依赖也能使用基础版。

进阶版配置：
1. [从官方发布页直接下载 RealESRGAN_x4plus_anime_6B.pth](https://github.com/xinntao/Real-ESRGAN/releases/download/v0.2.2.4/RealESRGAN_x4plus_anime_6B.pth)。
2. 放入 `ComfyUI/models/upscale_models/RealESRGAN_x4plus_anime_6B.pth`；目录不存在时创建。共享模型安装请使用 ComfyUI 已配置的 `upscale_models` 目录，不能把文件放入 `loras`。
3. 在 ComfyUI Manager 搜索并安装 [Ultimate SD Upscale](https://github.com/ssitu/ComfyUI_UltimateSDUpscale)，重启 ComfyUI。
4. 开启进阶版，确认模型文件名并保存。开关不会自动下载或安装；依赖未齐时先使用基础版。

两套模板均内置：缺失恢复只补缺失文件，手动恢复会恢复两套。workflow 目录被 Git 忽略，发布时需同步两份 JSON。后端及前端需重新加载后使用新开关。

以下为进阶方案的参数、实验记录和限制。

## 进阶版（v5，分块版）

目标：放大后补充细节、保持清晰线条。全局 LoRA 可任意配置或不配置，不按文件名判断用途，不自动降低客户的 LoRA 权重。

## 链路

`LoadImage → UpscaleModelLoader / ImageUpscaleWithModel → Lanczos 缩至目标长边 → UltimateSDUpscaleNoUpscale（1024 分块） → 可选原图融合 → PreviewImage`

- 默认放大模型为 `RealESRGAN_x4plus_anime_6B.pth`，需要安装在 ComfyUI 的 `models/upscale_models`（或已配置的共享目录）。需要 Ultimate SD Upscale 节点包（本机已安装）。
- 放大模型可在现有 HiresFix 设置中换成任意本机兼容超分模型；留空时明确走 Lanczos，运行图谱会移除超分节点和模型依赖。模型缺失时 ComfyUI 会报错，不悄悄降级导致画质改变。
- Anime6B 是动漫超分模型，不是画风 LoRA。它先清理/重建像素边缘，再给扩散采样补细节；也可能抹去原有纸纹、笔触，不保证所有风格适合。
- 模型原生放大倍率与最终尺寸分开：Anime6B 原生 4 倍，随后缩到指定长边。1600×1200 原图，长边设置 3200 才是 2 倍；原先 2000 仅为 1.25 倍。
- 原图融合默认 **0**。混入原图插值可能削弱锐度，线条位移时还可能重影。旧版的 0.2 不适合作为追求锐利线条的统一默认值。
- 新安装重绘默认 0.2；它是试调起点。放大后需要更多细节通常要适量重绘，但提高数值也可能改形；不能针对任意 LoRA 保证同一参数最优。
- 每块 1024×1024，padding 128、mask blur 24、Chess 顺序，低重绘合成。分块减少整张大画布重绘带来的碎线，但仍可能出现接缝、局部重复物体或内容漂移；不等于像素级保真。分块参数可在 ComfyUI 节点中调整。

进阶文件：`workflow/放大细化工作流-进阶.json`。内置恢复模板：`agent-core/src/services/workflowTemplates.js`。

## 采样与 LoRA

跟随原图模式继承当前对应源工作流的唯一 KSampler 的步数、CFG、采样器、调度器，不继承 denoise=1。
源模板缺失、参数不全或有多个 KSampler 时回退显式细化参数。这里的来源是当前模板，不是历史图片完整执行快照。
自定义模式使用细化步数/CFG和细化模板的采样器/调度器。若细化专用 LoRA 改变采样要求，应按该模型说明设置。
已有客户保存过步数/CFG但没有采样模式时继续使用自定义，避免升级覆盖显式选择。

LoRA 合并顺序：全局（按场景过滤，乘显式倍率，默认 1）→ 角色 → 细化专用；同路径后者覆盖前者。
全局倍率不影响角色和细化专用项。零权重项移除，并停止注入对应独立触发词；不猜测删除原提示词正文内的触发词。
放大模型与 LoRA 是两个独立配置，没有任何 dim23 特判。

支持现有 UNETLoader / CLIPLoader / VAELoader 图片模板。特殊 conditioning、模型 patch、CheckpointLoader、多阶段采样等架构需适配，不能把任意 LoRA 可替换解释为支持任意模型架构。

## 为什么与 WebUI 不一样

ComfyUI 官方本就提供 ESRGAN 像素放大再二次采样的 HiresFix 示例，功能并不缺失。
之前比较中，放大器（Lanczos vs Anime6B）、倍率（1.25 vs 2）、底模（Anima vs Illustrious）、VAE、采样配置都有变化，不能单归因于 ComfyUI。
也不要误解“12 步、denoise 0.3”为只采样 3.6 步：ComfyUI 标准 KSampler 会扩展完整噪声计划后截取指定步数；A1111 显式 Hires 步数也有类似的固定步数计算。

参考：
- [ComfyUI 官方 HiresFix 示例](https://comfyanonymous.github.io/ComfyUI_examples/2_pass_txt2img/)
- [Real-ESRGAN 官方 Anime6B 说明与模型下载](https://github.com/xinntao/Real-ESRGAN/blob/master/docs/anime_model.md)
- [A1111 HiresFix 功能说明](https://github.com/AUTOMATIC1111/stable-diffusion-webui/wiki/Features)
- [A1111 img2img 步数实现](https://github.com/AUTOMATIC1111/stable-diffusion-webui/blob/master/modules/sd_samplers_common.py)
- [Ultimate SD Upscale 原作者说明](https://github.com/ssitu/ComfyUI_UltimateSDUpscale)
- [Anima 官方模型参数说明](https://huggingface.co/circlestone-labs/Anima)
- [社区复现 A1111 ESRGAN HiresFix 讨论](https://www.reddit.com/r/comfyui/comments/18fcpk4/reproduce_a1111_hires_fix_with_resrgan_in_comfyui/)

## 本次验证

实验记录在 `output/hires-v4-review`。使用同一张 1600×1200 原图、种子 20260930，放至 3200×2400。
`lanczos.json` 与 `anime6b.json` 仅改变前置放大器，均保持 Base 底模、现有全局 LoRA、细化 Turbo LoRA 0.2、12 步、CFG 1、重绘 0.3。
Anime6B 纯超分的线条明显干净，但两组经过这个采样组合后都出现碎线，证明只替换放大器仍不足。
`vae-roundtrip.json` 分别执行普通/分块 VAE 编解码，不做重绘；两者均基本保持清楚的轮廓，未复现严重碎线。
`anime6b-base.json` 另测 Base 原生采样组合：保留全局 LoRA，去掉细化加速 LoRA，31 步、CFG 5，其余一致。它是受控实验，不是强制所有客户使用的参数。该组仍出现碎线，排除了“只要去掉加速 LoRA、恢复 Base 参数就能解决”的假设。
`anime6b-euler.json` 改用 Euler/simple、24 步、重绘 0.2，整图仍碎线。
`crop-base.json` 在相同 Base、全局 LoRA、er_sde/beta、31 步、CFG 5、重绘 0.3 下，仅裁出 1024 区域重绘，轮廓恢复干净；但也出现局部内容变化。
因此最终采用通用分块细化，`tiled-base.json` 已完成完整 3200×2400、重绘 0.2 验证，发梢、面部、衣服和刀鞘线条明显比整图重绘干净，未见明显硬接缝；部分背景笔触更平滑，局部轮廓/高光有改变，不宣称所有纹理都增加；此前纯官方节点整图模板保存在 `output/hires-v4-review/whole-image-template.json`，仅作为此前实验记录。

正式测试覆盖不同/多个/负权重/零权重/无 LoRA、场景过滤、覆盖顺序、源参数继承与回退、模型可替换与无超分依赖路径、GUI/API接线、设置持久化及透明背景。新增设置复用 Linshe 组件，检查桌面和 390px 移动端暖色/暗夜布局及空模型保存。

## 分发与回退

内置基础及进阶模板用于新安装/缺失文件恢复；本机两份文件已同步。workflow 目录被 Git 忽略，分发时需更新该 JSON；不会自动覆盖客户自行编辑的现存文件。
v3/v4 标记仍兼容，旧模板保留原采样逻辑；超分设置用于 v4/v5 图谱。
旧版备份 `workflow/放大细化工作流-v1备份.json` 可替换回主文件。更新服务与设置界面需重新加载后端/前端。
历史 v2/v3 实验仅供回顾，不作为当前默认流程或所有客户画质保证。

本轮测试配置（便于复现）：长边 3200，原图融合 0，重绘 0.2，Base 源采样参数 31 步/CFG 5/er_sde/beta，全局 LoRA 保持 1；细化专用加速 LoRA 在该对照中关闭。客户的全局 LoRA 不受此测试配置限制。既有数据库设置未被强制替换，使用推荐参数须在 HiresFix 设置保存。

补充验证：`smoke-no-lora.json` 从最终服务构图入口生成，无全局/角色/细化 LoRA，1024 长边执行成功（仅验证运行路径，不充当两倍画质对照）；`crop-current.json` 保留原有 Turbo LoRA 0.2、12 步、CFG 1，在 1024 区域、重绘 0.2 下也恢复干净线条。因此没有按 LoRA 文件名强制删除加速项。18 项正式测试和前端构建通过。
