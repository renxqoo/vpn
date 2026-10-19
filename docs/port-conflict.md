# 启动端口冲突排查与修复

问题：原始 Bun.listen 错误只显示 Failed to listen at 127.0.0.1，用户无法知道失败的是HTTP、SOCKS还是API。订阅的silent级别还会隐藏监听阶段日志。

2026-10-20 实机只读排查：netstat 显示7890由root进程 /Users/wrr/.config/com.vortex.helper/com.vortex.helper（PID293）监听；当前用户lsof未显示该root监听，但直接绑定7890得到EADDRINUSE。7891、9090与备选17890绑定均可用。

修复：用户家目录配置HTTP端口从7890改为17890，其余字段保留；系统代理依旧在start监听成功后使用实际端口设置。App的三个监听阶段包装错误，保留种类、完整端点、系统code、原始cause与对应CLI端口参数；EACCES等不能误报端口占用。绑定失败仍释放先前已创建的监听器，不影响端口原有进程。不自动选择随机端口，不关闭占用者，不改转发路径。

验证口径：HTTP/SOCKS/API分别占用，断言具体端点/错误码/参数、已启动资源释放且占用者仍可连接；验证非端口冲突错误。CLI在订阅silent模式下仍应显示明确fatal错误。正常使用所选端口可启动，无系统代理修改的验证应使用 --no-system-proxy。

核销：家目录HTTP端口已改为17890；实际执行 start --direct --no-system-proxy，17890/7891/9090均成功监听、控制API返回200，诊断进程退出0且controller已清理。原占用进程未停止，没有修改系统代理。

检查结果：check 99文件通过、lint 0问题、build成功、fmt 106文件通过、diff检查通过。全量282通过、1个既有opt-in跳过、0失败，1155断言、44测试文件；行覆盖率88.32%、函数覆盖率82.38%。
