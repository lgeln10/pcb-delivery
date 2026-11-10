# `.asc/` —— App Store Connect API 凭据

**这个目录除本文件与 `config.json.example` 外全部 gitignore。别把 `.p8` 提交进任何仓库。**

## 为什么用 API Key 而不是 Apple ID + 密码

Apple ID 登录**过不了双因素认证**,任何无人值守环境(CI、脚本、定时任务)都跑不了;
而 App Store Connect API Key 是为程序访问设计的,没有 2FA 这一层,权限还能单独收窄。

## 怎么拿(**只有 Account Holder 能做,网页操作,没有 API**)

1. App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**
2. 生成一个密钥,角色选 **App Manager**(足够发版与管理 TestFlight;**别给 Admin**)
3. 记下 **Issuer ID**(页面顶部)与 **Key ID**
4. 下载 `AuthKey_XXXXXXXXXX.p8` —— **只能下载一次**,丢了只能作废重发

## 放这里

```
mobile-app/.asc/
├── config.json                 ← 从 config.json.example 复制后填
└── AuthKey_XXXXXXXXXX.p8       ← 下载来的私钥原文件
```

```bash
cd mobile-app
cp .asc/config.json.example .asc/config.json   # 再填 keyId / issuerId / keyFile
chmod 600 .asc/AuthKey_*.p8
./scripts/asc.py whoami                        # 验一下能不能用
```

## 备份

`.p8` 与 Android 的 keystore 一样,**丢了要走作废重发流程**(比 keystore 好一点,不是不可逆,
但重发期间所有自动化都停摆)。存进公司密码库,别只留在一台电脑上。

## CI 上怎么给

不要把文件塞进仓库。GitHub Actions 用三个 secret:
`ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_P8_BASE64`(`base64 -i AuthKey_*.p8`),
工作流运行时在 runner 上现写出 `.asc/`,用完即弃。见 `.github/workflows/ios-release.yml`。
