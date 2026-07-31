# Lunkr 密码安全保存

Lunkr 默认仍然不保存邮箱密码。需要在 Session 失效后自动续登时，使用显式参数：

```powershell
npm run lunkr:login -- --store-password
```

登录成功后的状态输出应包含：

```json
"passwordStored": true
```

密码不会写入 `.env.local`、`session.json`、命令行、日志或 Git。程序通过独立的
Windows PowerShell 子进程调用当前 Windows 用户的 DPAPI，保存文件默认为：

```text
%USERPROFILE%\.config\pseagent-lunkr\password.dpapi.json
```

文件只包含邮箱、创建时间和 DPAPI 密文。密文绑定当前 Windows 用户和设备，
复制到其他用户或电脑不能解密。

以后执行：

```powershell
npm run lunkr:start
```

若现有 Session 有效，程序直接使用现有 Session；若 Session 已失效，则自动解密
已保存密码并重新登录。自动续登成功会输出：

```text
lunkr.session.renewed_from_stored_password
```

如果服务端要求 OTP、验证码或其他二次验证，后台启动不会尝试绕过，仍需重新执行
交互式登录命令。

清除已保存密码：

```powershell
npm run lunkr:forget-password
```

修改邮箱密码后，应重新执行带 `--store-password` 的登录命令覆盖旧密文。
