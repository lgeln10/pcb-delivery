// 壳登录页:服务器域名 + 手机号 + 密码 → 原生调 /api/auth/login → 会话写 Preferences →
// 跳到 WebHost 加载租户 H5。
//
// ★逻辑与 mobile-app/shell/app.js 一一对应(冷启动静默校验、AMBIGUOUS_TENANT 展开租户输入、
//   网络不可达时给「仍然进入」逃生口)。两边行为必须一致 —— 同一个客户可能一半人用 iOS 壳、
//   一半人用鸿蒙壳,登录体验不该有两种说法。
import router from '@ohos.router';
import http from '@ohos.net.http';
import common from '@ohos.app.ability.common';
import { Prefs, PREF_SERVER, PREF_SESSION, PREF_LAST_PHONE } from '../util/Prefs';
import { Http, HttpResult } from '../util/Http';
import { normalizeServer, NormalizedServer, tokenLooksAlive } from '../util/ServerUrl';

@Entry
@Component
struct Login {
  @State server: string = '';
  @State phone: string = '';
  @State password: string = '';
  @State tenantId: string = '';
  @State tenantVisible: boolean = false;
  @State error: string = '';
  @State busy: boolean = false;
  @State booting: boolean = false;
  @State bootText: string = '正在进入…';
  /** 网络不可达时才出现:会话还在,只是这次验不了,给个不至于把人锁在门外的出口 */
  @State enterAnywayVisible: boolean = false;
  private bootCancelled: boolean = false;

  async aboutToAppear(): Promise<void> {
    const context = getContext(this) as common.UIAbilityContext;
    await Prefs.init(context);
    await this.boot();
  }

  // ── 冷启动:有会话就静默校验后直接进 ──────────────────────────────────────
  private async boot(): Promise<void> {
    const savedServer: string = await Prefs.get(PREF_SERVER);
    const sessionRaw: string = await Prefs.get(PREF_SESSION);
    const lastPhone: string = await Prefs.get(PREF_LAST_PHONE);

    if (savedServer.length > 0) {
      this.server = savedServer.replace('https://', '');
    }
    if (lastPhone.length > 0) {
      this.phone = lastPhone;
    }
    if (savedServer.length === 0 || sessionRaw.length === 0) {
      return;
    }
    const token: string = Http.stringField(sessionRaw, 'token');
    if (token.length === 0) {
      return;
    }
    // 本地就能判死的过期不必发请求
    if (!tokenLooksAlive(token)) {
      await Prefs.remove(PREF_SESSION);
      this.error = '登录已过期,请重新登录';
      return;
    }

    this.booting = true;
    const res: HttpResult = await Http.request(http.RequestMethod.GET, `${savedServer}/api/me`, token, '');
    if (this.bootCancelled) {
      return;
    }
    if (!res.failed && res.status === 200) {
      this.enter(savedServer);
      return;
    }
    this.booting = false;
    if (res.failed) {
      // 断网:不清会话(可能只是没信号),给逃生口
      this.error = '无法连接服务器,请检查网络后重试';
      this.enterAnywayVisible = true;
      return;
    }
    if (res.status === 401) {
      await Prefs.remove(PREF_SESSION);
      this.error = '登录已过期,请重新登录';
      return;
    }
    const msg: string = Http.errorField(res.body, 'message');
    this.error = msg.length > 0 ? msg : `服务器校验失败(${res.status}),可稍后重试`;
    this.enterAnywayVisible = true;
  }

  private enter(origin: string): void {
    router.replaceUrl({ url: 'pages/WebHost', params: { origin: origin } });
  }

  // ── 登录提交 ─────────────────────────────────────────────────────────────
  private async submit(): Promise<void> {
    this.error = '';
    const norm: NormalizedServer = normalizeServer(this.server);
    if (norm.error.length > 0) {
      this.error = norm.error;
      return;
    }
    const origin: string = norm.origin;
    const phone: string = this.phone.trim();
    if (phone.length === 0) {
      this.error = '请输入手机号';
      return;
    }
    if (this.password.length === 0) {
      this.error = '请输入密码';
      return;
    }

    let body: string = `{"phone":${JSON.stringify(phone)},"password":${JSON.stringify(this.password)}`;
    const tid: string = this.tenantVisible ? this.tenantId.trim() : '';
    if (tid.length > 0) {
      body += `,"tenantId":${JSON.stringify(tid)}`;
    }
    body += '}';

    this.busy = true;
    const res: HttpResult = await Http.request(http.RequestMethod.POST, `${origin}/api/auth/login`, '', body);
    this.busy = false;

    if (res.failed) {
      this.error = '无法连接服务器,请检查服务器地址与网络';
      return;
    }
    if (res.status === 200) {
      const token: string = Http.stringField(res.body, 'token');
      if (token.length > 0) {
        // ★整个响应体原样存进 aios.session:H5 侧 native-app.ts 读的是 {token, employee}
        //   这个形状,自己重新拼一遍只会引入不一致。
        await Prefs.set(PREF_SESSION, res.body);
        await Prefs.set(PREF_SERVER, origin);
        await Prefs.set(PREF_LAST_PHONE, phone);
        this.enter(origin);
        return;
      }
    }
    const code: string = Http.errorField(res.body, 'code');
    const msg: string = Http.errorField(res.body, 'message');
    if (code === 'AMBIGUOUS_TENANT') {
      this.tenantVisible = true;
      this.error = msg.length > 0 ? msg : '该手机号存在于多个企业,请填写租户 ID 后重试';
    } else if (res.status === 401) {
      this.error = '手机号或密码不对';
    } else if (res.status === 403) {
      this.error = msg.length > 0 ? msg : '该账号当前不可登录,请联系企业管理员';
    } else if (res.status === 404 || res.body.length === 0) {
      this.error = '该地址不是有效的企业服务器,请核对服务器地址';
    } else {
      this.error = msg.length > 0 ? msg : `登录失败(${res.status}),请稍后重试`;
    }
  }

  build() {
    Stack() {
      Column() {
        // 品牌区
        Column() {
          Text('AI')
            .width(56).height(56)
            .borderRadius(16)
            .backgroundColor('#2f6bed')
            .fontColor(Color.White)
            .fontSize(22).fontWeight(FontWeight.Bold)
            .textAlign(TextAlign.Center)
          Text('企业AI操作系统').fontSize(20).fontWeight(FontWeight.Bold).margin({ top: 12 })
          Text('输入企业服务器地址与账号登录').fontSize(13).fontColor('#8a94a6').margin({ top: 6 })
        }
        .margin({ top: 48, bottom: 28 })

        Column() {
          if (this.error.length > 0) {
            Text(this.error)
              .fontSize(13).fontColor('#e0483d')
              .padding(10)
              .width('100%')
              .backgroundColor('#fdeeec')
              .borderRadius(8)
              .margin({ bottom: 12 })
          }

          this.Field('服务器地址', '企业管理员提供的访问域名,无需填写 https://')
          TextInput({ text: this.server, placeholder: 'your-company.example.com' })
            .type(InputType.Normal)
            .onChange((v: string) => { this.server = v; })
            .margin({ bottom: 14 })

          this.Field('手机号', '')
          TextInput({ text: this.phone, placeholder: '登录手机号' })
            .type(InputType.PhoneNumber)
            .onChange((v: string) => { this.phone = v; })
            .margin({ bottom: 14 })

          this.Field('密码', '')
          TextInput({ text: this.password, placeholder: '密码' })
            .type(InputType.Password)
            .onChange((v: string) => { this.password = v; })
            .margin({ bottom: 14 })

          if (this.tenantVisible) {
            this.Field('租户 ID', '该手机号存在于多个企业,请向管理员索取租户 ID')
            TextInput({ text: this.tenantId, placeholder: '管理员提供的租户 ID(UUID)' })
              .onChange((v: string) => { this.tenantId = v; })
              .margin({ bottom: 14 })
          }

          Button(this.busy ? '登录中…' : '登 录')
            .width('100%').height(46)
            .enabled(!this.busy)
            .backgroundColor('#2f6bed')
            .onClick(() => { this.submit(); })

          if (this.enterAnywayVisible) {
            Button('仍然进入(跳过在线校验)')
              .width('100%').height(42)
              .backgroundColor(Color.Transparent)
              .fontColor('#2f6bed')
              .margin({ top: 8 })
              .onClick(async () => {
                const s: string = await Prefs.get(PREF_SERVER);
                if (s.length > 0) {
                  this.enter(s);
                }
              })
          }
        }
        .width('100%')
        .padding(20)
        .backgroundColor(Color.White)
        .borderRadius(14)

        Text('登录即进入企业自有部署环境\n数据存储于企业服务器')
          .fontSize(12).fontColor('#9aa6b8').textAlign(TextAlign.Center)
          .margin({ top: 20 })
      }
      .width('100%').height('100%')
      .padding({ left: 20, right: 20 })
      .backgroundColor('#f5f7fa')

      // 冷启动遮罩
      if (this.booting) {
        Column() {
          LoadingProgress().width(40).height(40).color('#2f6bed')
          Text(this.bootText).fontSize(14).fontColor('#5b6474').margin({ top: 12 })
          Button('取消,重新登录')
            .backgroundColor(Color.Transparent).fontColor('#2f6bed').fontSize(13)
            .margin({ top: 16 })
            .onClick(async () => {
              this.bootCancelled = true;
              this.booting = false;
              await Prefs.remove(PREF_SESSION);
            })
        }
        .width('100%').height('100%')
        .justifyContent(FlexAlign.Center)
        .backgroundColor('#f5f7fa')
      }
    }
  }

  @Builder
  Field(label: string, hint: string) {
    Column() {
      Text(label).fontSize(13).fontColor('#5b6474').width('100%')
      if (hint.length > 0) {
        Text(hint).fontSize(11).fontColor('#9aa6b8').width('100%').margin({ top: 2 })
      }
    }
    .margin({ bottom: 6 })
  }
}
