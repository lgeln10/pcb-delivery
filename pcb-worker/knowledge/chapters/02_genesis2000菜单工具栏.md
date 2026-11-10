# 第二章 gensis2000菜单工具栏操作及功能

<!-- page:24 -->
## 第一节 软件菜单中英文说明

| 英文 | 中文 |
|---|---|
| Create | 创建 |
| Rename | 更改 |
| Delete | 删除 |
| Export job | 输出料号 |
| Import job | 导入料号 |
| Save | 保存 |
| Quit | 离开 |
| Input | 导入 |
| Output | 导出 |
| Matrix | 模板 |
| Steps | 工作单元 |
| Symbols | 元素库 |
| Wheels | /D码库 |
| Path | 路径 |
| Job | 料号 |
| Step | 工作单元 |
| Editor | 编辑 |
| Exclude | 排除 |
| Identify | 识别 |
| Translate | 转换 |
| Close | 退出 |
| Insert | 插入 |
| Add | 增加 |
| Row | 行 |
| Column | 列 |
| Orig | 原始 |
| Edit | 编辑 |
| Board | 板 |
| Misc | 混合层 |
| Signal | 信号 |
| Power_ground | 电源 |
| Mixed | 混合层 |
| Solder_mask | 阻焊 |
| Silk_screen | 丝印 |
| Solder_paste | 锡膏 |
| Drill | 钻孔 |
| Rout | 锣带 |
| Document | 文档 |
| Positive | 正性 |
| Negative | 负性 |
| File | 文件 |
| Save | 保存 |
| Script | 脚本 |
| Locks | 锁 |
| Close | 退出 |
| EDIT | 编辑 |
| Undo | 撤消 |
| Delete | 删除 |
| Move | 移动 |
| Copy | 拷贝 |
| Same Layer | 同层 |
| Other Layer | 另一层 |
| Step&Repeat | 陈列 |
| Apply | 应用 |
| Close | 关闭 |
| Substitute | 替换 |

<!-- page:25 -->
| 英文 | 中文 |
|---|---|
| Resize | 放大/缩小 |
| Global | 改变大小 |
| Transform | 改变 |
| Connections | 倒角 |
| Reshape | 更改集合 |
| Change symbol | 更改元素 |
| Break | 打散 |
| Arc to Lines | 弧转线 |
| Line to Pad | 线转PAD |
| Pad to line | 盘转线 |
| Contourize | 铜皮转光栅 |
| Fill | 填充 |
| Polarity | 极性 |
| Positive | 正 |
| Negative | 负 |
| Invert | 转换 |
| Create | 创建 |
| Symbol | 元素符号 |
| Profile | 轮廓 |
| Layer | 层 |
| Padup | 谷大pad |
| paddn | 缩小pad |
| reroute | 绕线路 |
| Shave | 削pad |
| linedown | 缩线 |
| line/signal | 线 |
| in | 里面 |
| out | 外面 |
| Same layer | 同一层 |
| Other layel | 另一层 |
| cu | 铜皮 |
| spacing | 间隙 |
| top | 顶层 |
| bot | 底层 |
| Soldermask | 绿油层 |
| silk | 字符层 |
| Close | 关闭 |
| zoom | 放大缩小 |
| create | 创建 |
| snap | 捕捉 |
| board | 板 |
| Route | 锣带 |
| repair | 修理、编辑 |
| resize | 放大缩小 |
| analysis | 分析 |
| Sinde | 边、面 |
| Advanced | 高级 |
| measuer | 测量 |
| output | 导出 |
| PTH hole | 沉铜孔 |
| NPTH hole | 非沉铜孔 |
| VIA hole | 导通孔 |
| smd pad | 贴片 |
| replace | 替换 |
| Attribute | 属性 |
| Select | 选择 |
| round | 圆 |
| square | 正方形 |
| rectangle | 矩形 |
| Reshape | 改变形状 |

<!-- page:26 -->
| 英文 | 中文 |
|---|---|
| profile | 轮廓 |
| drill | 钻带 |
| rout | 锣带 |
| Actions | 操作流程 |
| DFM | 自动功能 |
| circuit | 线性 |
| Identify | 识别 |
| Translate | 转换 |
| job matrix | 工作室 |
| repair | 修补、改正 |
| Misc | 辅助层 |
| dutum point | 相对原点 |
| corner | 直角 |
| optimization | 优化 |
| origin | 零点 |
| center | 中心 |
| global | 全部 |
| check | 检查 |
| reference layer | 参考层 |
| reference selection | 参考选择 |
| reverse selection | 反选 |
| snap | 对齐 |
| invert | 正负调换 |
| symbol | 元素 |
| feature | 半径 |
| histogram | 元素 |
| exist | 存在 |
| angle | 角度 |
| dimensions | 标准尺寸 |
| panelization | 拼图 |
| fill parameters | 填充参数 |
| redundancy | 沉余、清除 |
| Select Drawn | 选铜 |
| Graphic Snapshot | 切图 |
| Netlist Analyzer | 网络对比 |
| Notes | 标注 |

<!-- page:27 -->
## 第二节 工具栏的基本操作

### genesis2000安装

以genesis2000 9.7版本为例：

1.把genesis2000压缩包复制到E盘目录下并解压出来：

2.双击 install.bat 文件，弹出：

然后按顺序点击2、3、4、点击5之后，弹出窗口：选择"Server"手动输入gensis2000安装路径：D:/genesis/

<!-- page:28 -->
**genesis2000安装**

3.点击"Start",进入安装，一路点击acept OK 就好

<!-- page:29 -->
**genesis2000安装**

4.提示安装驱动，如图选择32位，安装失败没有关系。效果如下图，退出，进入下一步：

5.提示安装licenese,点击yes,提示安装错误，点击OK

<!-- page:30 -->
**genesis2000安装**

6.设计用户名，密码及工作组 可以全部设计成1

7设计逻辑数据库（set logical databases),点击yes, 点击Apply 然后Quit 退出

<!-- page:31 -->
**genesis2000安装**

回到安装文件夹：

<!-- page:32 -->
**genesis2000安装**

点击yes 点击next

<!-- page:33 -->
**genesis2000安装**

一直点击next 到finish,操作完成，重新启动电脑

重新启动电脑后，打开的：D:/genesis/e97/get 将里面的get.exe,gfx.exe,发送到桌面快捷方式即可，打开桌面上Xmanager1.3.9文件夹，将里面"XMANAGER.EXE"发送到桌面快捷方式即可

<!-- page:34 -->
### genensis2000使用

先点击桌面上 然后点击get.exe出现一下界面：输入用户名 密码，回车，进入genesis2000系统界面

<!-- page:35 -->
### genesis2000系统菜单说明

系统界面file菜单 系统界面Actions菜单 系统界面Options菜单 系统界面Windowns菜单

<!-- page:36 -->
**genesis2000系统菜单说明**

genesis2000 工作料号（Job)中图标注释

genesis2000读入资料菜单注释

<!-- page:37 -->
### Genesis2000 读资料时格试参数菜单注解

通过右键菜单的 View Ascii 查看该文件的原始代码由原始代码我们可以知道该 Gerber 文件以下信息：

①数位是几位(以最多位数的为标准)?

②单位

③补零方式

例、假设查得原始代码如下

```
G54D110*
G01X1001500Y954500D02*
G01X1004500D01*
G01X1003000D02*
```

我们可以得出

两个字母之间最多有七位

那么有可能小数位前是两位或三位

也就是说数位可能 2：4 制或是 3：5 制；

(甚少是 1：6、6：1、5：2 或 4：3 所以要猜)

确定了小数点位置后，就知道了实际大小

由实际大小我们也可以猜到该文件采用了什么单位；

零加在后面了就说明是后补零方式(补零和省零是不同的意思，注意一字之差)

<!-- page:38 -->
### Genesis2000 读文件时调格试

通过右键菜单的 Parameters 调出参数菜单对之进行相应修正

许多都是由于补零方式不对和数位不对导致问题，如果这两样还解决不了问题，则要考虑单位问题了，最后才去查看 D 码文件。

<!-- page:39 -->
### Genesis2000 读 GBR 时自建 D 码

<!-- 原文中的 "à" 为 PPT 箭头符号导出后的字符，保留原样 -->

通过右键菜单的 open wheel template……打开 D 码学习器.

自建 D 码的完整步骤如下：

1> 在 Wheel Template Editor 中，FileàCreate，右边即会变为淡蓝色，当前打开的 Wheel 文件将被做为 D 码样本

2> 接下来设定要建立的 D 码文件的一些参数，ParamsàGlobal，参数设置如下：

A>Wheel type： 设置 D 码文件的类型用

如果当前文件为 Gerber 文件的 D 码则选 Gerber；如果是钻孔文件用的 D 码则选 Tools

B>Units：选择要创建的文件即将用的单位，有 Inch ，mm ，mil 三种单位可选

C>Dcode numbering 为 D 码编号规则，有下列几项可选：

- Explicit 采用当前样本的编号规则
- Standard 按下面的顺序指定编号：D10-19 D70-71 D20-29 D72-73 D30-69 D74 –75
- Station 从文件中取得后再转换成上面的标准顺序
- Order1 从 D01 开始编号
- Order4 从 D04 开始编号
- Order10 从 D10 开始编号

3>ParamsàConditional Units 定义 D 码的默认单位(此步可有可无)，使用方法类似第四步

4>定义文件头部说明性内容，系统会根据这些说明更快有高效的识别 D 码

选中右边表头上面比较典型的几行，最好是通过这几行就大概能确定是这类 D 码

打开 Paramsàheadline 在弹出窗口中点 Add 即可

<!-- page:40 -->
### Genesis2000 D 码学习器菜单注解

D码调格式功能

定义好 D 码后使用应用功能刷新一下 D 码就定好了.

<!-- page:41 -->
### 层次特性 matrix 功能菜单注解

功能: 层命名 层排序 定义层的属性 备份层 备份 Setp

层的命名:

统一命名是为了方便分工协作,比如后工序知道菲林属于那一层

根据各个工厂的内部规定不同，有各自的命名规则。正确命名是自动排序的前提

下面常规命名规则举例：

假设有一块四层板,命名如下

| 层 | 英文名 | 命名 |
|---|---|---|
| 顶层文字 | Top Silk Screen | GTO |
| 顶层防焊 | Top Solder Mask | GTS |
| 外层的顶层 | Top Layer | GTL |
| 内层第一层 | Power Ground (GND) | L2 |
| 内层第二层 | Signal Layer | L3 |
| 外层的底层 | Bottom Layer | GBL |
| 底层防焊 | Bottom Solder Mask | GBS |
| 底层文字 | Bottom Silk Screen | GBO |

<!-- page:42 -->
### 层次特性 matrix 常用功能菜单注解

EDIT编辑菜单 Action :激活、动作

<!-- page:43 -->
### 图形编辑界面功能

<!-- page:44 -->
### 图形编辑界面功能-File(文件)

图形编辑界面功能-File(文件) 图形编辑界面功能-EDIT(编辑)

镜相/旋转/缩放比列功能 ALT+T

<!-- page:45 -->
### 图形编辑界面功能-EDIT(编辑)之.Reshape

Reshape:修改形状 Actions 行动

<!-- page:46 -->
### Actions 行动之网络分析(特色功能)

<!-- page:47 -->
### Options 选项

Options 选项 Analysis 分析 DFM(优化功能集,特色功能)

DFM Cleanup(线转 PAD)

<!-- page:48 -->
DFM NFP REMOVAL……删除独立 PAD

删除独立PAD DFM Pad Snapping(拉 PAD)PAD 对 PAD

DFM Optimization(优化选项) DFM Signal layer Opt(优化外层线路)

<!-- page:49 -->
### DFM 优化菜单

DFM Solder Mask Repair(优化阻焊) Step(拼板功能)

<!-- page:50 -->
### S&R Edit(拼板编辑器)(与编辑功能界面类似,编辑对相不同)

Table 手动拼板(可用于拼 SET 或 PNL)

<!-- page:51 -->
### Automatic 自动拼板(PNL)

Automatic 自动拼板(PNL) Output(文件输出)

<!-- page:52 -->
### Output(文件输出)

<!-- page:53 -->
## 第三节 gerber资料的方法及技巧

### gerber资料输入

一般流程：登入（genesis2000账号） 建立工作料号 调入客户gerber资料 自动识别 检查并纠正错误 转换

登入：

输入账号和密码

<!-- page:54 -->
进入genesis2000系统界面，建立工作料号（每个工厂命名不一样）：

点击工作料号"check"进入界面：

<!-- page:55 -->
调入客户原始资料，点击input进入界面：

<!-- 以下为图上标注文字 -->

资料来源及目的地

控制开关

点击Identify自动识别

自动识别后检查无误之后点击"Translate"

功能键 资料转换

<!-- page:56 -->
资料自动识别及转化说明：

Genesis系统在读入过程中要处理的对象大概可分为以下几种：

Gerber文件；钻孔文件；D码文件；(其他文件都不用管，区分这三种文件我们可以从上图中文件格式入手，三者对应Format分别为Gerber或Gerber274X；Excellon2：Wheel

<!-- page:57 -->
Gerber文件是一定有的，但一般分274D(格式名为Gerber)和274X(格式名为Gerber274X)两种，两者区别在于274X的Gerber文件自身包含了D码文件：

钻孔文件有时没有(这种的在输入过程暂时不管，在后面通过分孔图能转出来)，有的即使有也太多有错；

D码出错也是经常的；下面分别给予说明：

<!-- 以下为图上标注文字（文件列表各列的名称） -->

原始文件名 格式 参数数位 生成文件名

选择

如何在输入过程中处理Gerber文件

一般通过右键菜单的View Graphic(按住右键不松再移动光标)查看该文件对应的图象是否正确，如果对应图象显示不正确，则从以下几方面着手修正：

<!-- page:58 -->
通过右键菜单的View Ascii查看该文件的原始代码

由原始代码我们可以知道该Gerber文件以下信息：

①数位是几位(以最多位数的为标准)?

②单位

③补零方式

例、假设查得原始代码如下

```
G54D110*
G01X1001500Y954500D02*
G01X1004500D01*
G01X1003000D02*
```

我们可以得出

两个字母之间最多有七位

那么有可能小数位前是两位或三位

也就是说数位可能2：5制或是3：4制；(甚少是1：6、6：1、5：2或4：3)

确定了小数点位置后，就知道了实际大小

由实际大小我们也可以猜到该文件采用了什么单位；

零加在后面了就说明是后补零方式(补零和省零是不同的意思，注意一字之差)

<!-- page:59 -->
再通过右键菜单的Parameters调出参数菜单对之进行相应修正：

许多都是由于补零方式不对和数位不对导致问题，如果这两样还解决不了问题，则要考虑单位问题了，最后才去查看D码文件

<!-- page:60 -->
D码问题处理：

(1)缺少Wheel文件：

Gerber文件(有错，没指定Wheel，而且改了除Wheel外的所有参数都不能修正)

读入列表如没一个Wheel文件，则找ASCII文件看其代码，跟下面格式类似的可以转为Wheel文件；如列表中有Wheel文件，则在其参数直接指定试

(2)Wheel文件出错

Gerber或Execllon2文件(有错，而且改了除Wheel外的所有参数都不能修正)

这时就要看出错文件的Wheel文件(该文件的参数栏里注明了该文件用的哪个Wheel文件)

A) 找到对应Wheel文件，右击，选 Open wheel template ….

B) 打开D码学习器如右下图：

<!-- page:61 -->
<!-- 以下为图上标注文字 -->

图形基本形状 图形指定 (基本图形有:圆, 矩形, 圆环, 椭圆,正方形等 正方形)

栏位分析 (对应右边一行) (D码识别规则)

尺寸及角度

C:自建D码步骤如下：

1>在Wheel Template Editor 中，FileCreate，右边即会变为淡蓝色，当前打开的Wheel文件将被做为D码样本

<!-- page:62 -->
2>接下来设定要建立的D码文件的一些参数，ParamsGlobal，参数设置如下：

A>Wheel type： 设置D码文件的类型用

如果当前文件为Gerber文件的D码则选Gerber；如果是钻孔文件用的D码则选Tools

B>Units：选择要创建的文件即将用的单位，有Inch ，mm ，mil 三种单位可选

C>Dcode numbering为D码编号规则，有下列几项可选：

- Explicit 采用当前样本的编号规则
- Standard 按下面的顺序指定编号：D10-19 D70-71 D20-29 D72-73 D30-69 D74 –75
- Station 从文件中取得后再转换成上面的标准顺序
- Order1 从D01开始编号
- Order4 从D04开始编号
- Order10 从D10开始编号

3>ParamsConditional Units 定义D码的默认单位(此步可有可无)，使用方法类似第四步

4>定义文件头部说明性内容，系统会根据这些说明更快有高效的识别D码

选中右边表头上面比较典型的几行，最好是通过这几行就大概能确定是这类D码

打开Paramsheadline 在弹出窗口中点Add 即可

<!-- page:63 -->
5>Params Table title 设置D码转换的开始位置

Params Table Terminator设置D码转换的结束位置

使用方法跟第四步类似，一般最好设置开始位置，结束位置可不设

6>添加识别规则(许多D码文件只有一部分D码没识别出来，其实只要用这步，在原来的文件里添加识别对应D码的规则就可以，不用全部重建D码)

A>在右边列表里选则没识别的某类D码样式的第一个D码

B>EDITAdd record

C>在下拉单里选则对应的正确图形

D>再根据右边的数值配置D码识别规则，

E>再用此识别规则把右边该类D码全部转换识别过来 ActionsTranslate Wheel

<!-- 原文右侧示例（与 B–E 步并排排版） -->

```
D23 98 82 THER 0 13
D36 102 86 THER 0 95
D56 75 0 RND 0 40
D41 14 0 LINE 0 800
```

重复A-E五步把全部D码识别完为止即可

正确识别完后，一定要记得存盘退出哦

更详细的参考资料请看<<Genesis2000基础培训教程>>的P35-----P45

实在不行，D码问题也可以通过其他CAM软件来处理，比如用CAM350来识别有问题的gerber文件，然后再输出正确的即可。

<!-- page:64 -->
4，如何处理Excellon2文件

右击钻孔文件选 View graphic…得到下图：

框选放大图象看，虽然有大小之分，但不同大小的钻孔挨到一起去了，明显错误，

既然有错，我们应该先取得它的正确参数才 好去对比

右击它选 View Ascii…

得到文件的原始数据代码，其中一段为右图所示:

我们从代码可以看出是前补零，数值最少是五位数

但它现在用的参数却如下：

最明显是补零方式错误，它用的是后补零lead

那么我们就要修正过来：

右击该文件选Parameters…

<!-- page:65 -->
弹出以下参数设置窗口：

然后我们再去查看它的显示图象，如下图：一切正常！

<!-- page:66 -->
上面例子是GENESIS把客户原始钻孔文件自动识别分析时，没有正确识别补零方式。如果象上面改正了补零方式还不正常的话，则要调小数点位置了，上面是2:3,我们可以改为1:4\3:2\4:1等组合去看，移动小数点位置，使物件图象随坐标值增减而移动位置。如果还不能解决问题，则要试试调整单位看。调整单位还不行则去查看其对应D码文件有问题么，跟Gerber文件的D码处理方法一样。

如果以上方法都解决不了问题，则不处理钻孔文件，在后面用分孔图转出钻孔文件。

如果它代码中或lst文件中有刀的大小和个数，则参考分孔表，直接在钻孔管理器里输入即可.

点击："Translate"进入下面界面，框住处显示OK,表示资料已经读入genesis2000.资料输入已经完成。
