# 第三章 常见几种转gerber软件

<!-- page:67 -->
## 第一节 PADS软件

PADS格式文件一般有两种，一种是后缀为.PCB，一种为后缀.ASC；

### 一、PCB文件，直接可以点击打开：

<!-- page:68 -->
文件打开之后设计零点：如果不设计零点，分孔图表格就会进入单元里面，到时不好对孔数及属性，很容易判断错误，导致板子做错：如图：一般零点最好设计在右下角比较好。

<!-- page:69 -->
敷铜设计：敷铜一般有三种方式：灌注，填充，平面链接，如下图：

灌注，填充一般是用于线路正片敷铜的，平面链接一般用于内层负片敷铜的；

如果客户没有提供敷铜方式，一般需要用两种敷铜方式转不出来作比较，如果有不同，需要与客户确认是哪种方式敷铜是正确的。

<!-- page:70 -->
定义层：点击cam

<!-- page:71 -->
弹出如下：如果cam文档中有文件名先要删掉，再添加

<!-- page:72 -->
线路正片如下：点击添加弹出窗口，选择文档类型，选择布线/分割平面，在选择层top（顶层）在文档名称输入文件名点击剪头"层"注意看设计参数（底层线路步骤也是一样的）注意一般2D线不能勾。

<!-- page:73 -->
内层负片设计：选择文档类型中的CAM平面 点击"层"看参数，预览选择看图形，这个是PADS转资料很容易出错的地方，很容易把负片当正片转出来，导致资料错

<!-- page:74 -->
字符层：选择文档类型中的字符点击"层"看参数，点击箭头处"top"出现下面窗口勾起来的就是要选的。

点击出现下面窗口：

勾起来的一般都是要的

特别注意字符参数一定要对，这个是pads转资料很容易出错的地方

<!-- page:75 -->
助焊层：也就是我们常说贴片层

<!-- page:76 -->
阻焊层：

<!-- page:77 -->
分孔图：

<!-- page:78 -->
钻孔层：

<!-- page:79 -->
定义完层之后：cam文档中的文件全部选中，cam目录中选择导出资料所放目录，然后点击运行，资料就导出来，输出gerber资料就完成了

<!-- page:80 -->
*.ASC格式导入pads:

打开PADS，选择"文件"菜单中点击导入：

出现如下窗口：选中文件，打开就导入PADS中，导出gerber资料步骤同上。

<!-- page:81 -->
### 文件转换过程中常见的问题、错误信息提示及其解决方法：

1. 版本的如何识别？

由于POWER PCB软件的版本众多其所设计的文件目前无法通过文件来判别，只能询问设计人员

2. Hatch mode must be Normal to output copper-plot cancelled铺铜不成功的提示

在\\setup\preferences\Drafting目录中Hatch的选项改为Normal即可

1. Maximum number of apertures exceeded提示

在Define CAM Documents窗口任选中一个Document Name，进入Edit 窗口中→打开Device Setup 介面改大Aperture中数值即可

2. Fill width is too large for accurate pad fills ( eg. fill with=10 pad width=9.84)提示

进入\\CAM\Add中Document中选Routing→Device setup 把fill参数改小即可

3. 未定义（使用）Aperture

在Document Name中选中一层进行 Edit→选中Photo后再按 Device setup→运行Regenerate即可

其他错误提示

根据错误的信息进行判断，如果还无法解决需把转换的GERBER FILE发给客户确认并附带错误提示的内容

<!-- page:82 -->
## 第二节 DXP(AD) Protel 99 SE 软件

### 一、DXP（AD）

一、DXP（AD）有多种版本，一般版本都是不兼容的，大家一定要注意，相应文件要用相应版本打开,dxp文件有两种：一种后缀*.PCB，一种后缀.PCBdoc.

直接把文件拉到软件窗口，就可以打开，设计零点选择菜单"Edit"点击"Origin"选择"SET"放在右下角，如果需要导出分孔表，选择菜单:"Place"选择"String"放到右下角：点击右键：选择"properties"弹出窗口：选择箭头"legend"和"Drill drawing"

然后点OK.

<!-- page:83 -->
导资料有两种方式：一种gerber资料;一种"ODB++"

转gerber：

选择菜单File Fabriatiaon Outputs Gerber files

出现有图窗口：

选择箭头处：鼠标放在Plot处点击右键：出来后选择Plotlayers再选择used on 有用的层就勾起来了，再选择drilldrawing

<!-- page:84 -->
将箭头处勾起来，然后点击OK，gerber资料就输入到相应的目录下

<!-- page:85 -->
钻层输出：

选择菜单File Fabriation outputs Nc drill Files

弹出窗口点击"OK"这样钻层就输出到相应目录下，这样就OK了

<!-- page:86 -->
输出ODB++格式就比较简单：不需要再输出钻层

选择菜单File Fabriation outputs ODB++Files

鼠标放到Plot点击右键选择"use on"再点击 "OK"就输入到相应目录，然后在genesis中直接输入：打开genesis2000

<!-- page:87 -->
选择File Import Job 弹出窗口点击Input path输入路径见框住处 "Job Name"可以自己更改 点击OK

资料就导进genesis2000,可以进行编辑修改了.

<!-- page:88 -->
DXP(AD）文件注意事项：

1.注意要用相应的版本打开资料转资料，注意打开资料时提示；

用DXP（AD）打开文件后，会生成一个WEB文件，其中含有前PCB的版本信息，如下信息表示该PCB文件版本，是当前打开资料的版本大于还是小于当前的版本。

实际操作时，如不知道版本则首先用AD10打开PCB文件，再核对版本是否符合，对于不符合的则选用其他版本转换

版本区间检查：如有提示later,则表示是当前打开版本的后期版本（大于当前打开的版本）

<!-- page:89 -->
如有提示earlier,表示实际版本是早期版本，(小于当前打开的版本）

通过以上两者即可判断版本区域，再按版本对于的关系找对应版本转换

部分打开PCB后没有WEB文件的，请在PCB文件位置用浏览器打开查看。

总结：Protel DXP2004\Altium Designer 6.3\AD6.5/AD6.7\AD6.8等版本可用Altium Designer 6.8转gerber。Altium Designer 6.9\designer8.3\Summer 09\Winter 09\Altium Designer 10等版本可用Altium Designer 10转gerber。AD10以上的版本，用上面的方法找对应的版本转gerber。

如知道客户版本或者系统有备注该资料的设计版本请直接用对应的版本进行转换

<!-- page:90 -->
2.外形及槽孔锁住处理：

客户设计的PCB文件，用DXP打开时，发现GKO层的内槽锁死了，并且内槽很多，如果一个个的去点很麻烦，特别费时间！

下面，就有两种方法去一键解锁

方法一：

首先打开pcb文件，用dxp15以下的版本去打开，用来导外形，（注意：只能用于解锁外形来使用，其他层还是用相对应的版本来转资料）

按一下L键，出现以下窗口：

先点ALL layer off关闭掉所有层，然后再打开keepout-out layer，然后再点OK

出现如下界面：

<!-- page:91 -->
放大界面，选择其中一根线，选中之后，外形线上面有显示白色，然后右键点击线，选择第二项Build Query见附图：

出现以下界面，选择：Exists on layer

选择keepout layer，然后再点 apply 见附图

<!-- page:92 -->
去掉下图的keepout后面的勾 出现以下界面，自动切换为"False"

点击OK,然后点X关掉以下窗口

<!-- page:93 -->
方法二：

打开pcb文件，将所有层关闭，只显示GKO层，见附图所示

选中直线（线的上面有白色才为选中，见附图），选中之后在线上面点右键选择Find Similar Objects

<!-- page:94 -->
将Layer Keep Out Layer 后面的Any改为same

将Keepout 后面的Any改为same

<!-- page:95 -->
出现以下窗口，将下图的Keepout 后面的勾去掉，然后显示False

然后再选中圆弧，按照上述解锁线的同样的方法去解锁圆环

然后转出gerber文件与PCB文件对照看看还有没有特殊的槽或孔外形没有转出来。

<!-- page:96 -->
### 二、Protel 99 SE

PROTEL 99 SE 一般有两种文件格式，一种*.DDB和*.PCB

打开软件，File Open 找到所要调入文件的目录，

设计零点：edit Origin SET

零点一般设计在右下角比较好，

<!-- page:97 -->
分孔图表：

Place "string"选择"string"放到右下角，然后鼠标放在上面点击右键

选择弹出窗口选"Properties"出现如下窗口：将 "string"改为 ".legend"， "toplayer"改为 "Drilldrawing"

<!-- page:98 -->
转资料：File CAM Manager出现如下窗口

点击"Next"出现窗口选择"Gerber"再点击 "Next"

继续点击"Next"

<!-- page:99 -->
继续点击 "Next"

继续点击 "Next"

鼠标放在"Plot"点击右键出现"Plotlayer"选择"Used on"

继续点击 "Next"

继续点击 "Next"

<!-- page:100 -->
继续点击"Next"

继续点击"Next"

继续点击"Next"

点击 "Finish"

<!-- page:101 -->
鼠标放到 "Gerber Output 1"上点击右键

选 "Insert Nc Drill"

出现如下窗口：

点OK,出现如下窗口：

按快捷键 "F9"

<!-- page:102 -->
然后鼠标放到箭头处：

点击右键：选择："Export"找到输出目录下。

<!-- page:103 -->
### 常见问题和处理方法

1、光绘文件输出时，边框(keepout或GM1)层部分（或全部）丢失

原 因：客户定义的KEEPOUTLAYE层Properties属性中KEEPOUT选项选中，导致该层的边宽将无法输出

解决方法：把KEEPOUTLAYE层Properties属性中KEEPOUT选项取掉

注意：整个keepout边框有时由不同的线段组成，每段都需处理

<!-- page:104 -->
2、光绘文件中单面盘钻孔，导致孔钻断线和电地短路

原 因：由于PRTOEL软件中客户把某些盘定义有单面孔，输出NCDRILL时该位置便形成一个钻孔（见图5.1）

解决方法：把NCDRILL产生的孔与孔符图（ *.GG1 或*.GD1）比较，找出有孔没有孔符的位置，判断后删除

<!-- page:105 -->
3、光绘文件输出时，

①提示菲林尺寸不匹配 (The Film is too small for this PCB)

②用CAM软件调入时，各层都不对齐且偏向屏幕的一边

原 因：文件的实际尺寸与菲林不匹配,原点设置太远

解决方法：①在Gerber Output1界面中选中Gerber Output1按右键在弹出图中选择Properties→advanced，在Film Size栏目中调大X、Y、Border size 数值即可

②调整菲林的位置：Position on Film 选项中选 Reference to relative即可

<!-- page:106 -->
4、光绘文件输出时，有如下提示 (GERBER-Failed to Match All Shapes for *.pcb)图1解决方法：①在Gerber Output1界面中选中Gerber Output1按右键在弹出图中选择Properties→Apertures,不选Embedded Apertures,再点选Create List From PCB.然后按OK即可.(具体见图２)

图1 图2

<!-- page:107 -->
## 第三节 CAM350软件

CAM350一般可以打开两种格式的文件：一种*.CAM文件，一种gerber文件；

后缀为.cam文件用写字板打开：如图所示:

直接可以打开，如图：

选择 "open",找到需要打开的文件

点开文件图形就打开了

<!-- page:108 -->
gerber资料格式一般有两种即:"274D"和"274X"

以274X为例：打开CAM350

File Import

- Autoimport，自动导入文件
- 找到资料放在的相应目录
- Gerber Data 手动导入
- drill data 导入钻孔
- Mill Data 导入锣带
- DXF 导入outcad文件

<!-- page:109 -->
资料输出

File Export

Gerber Data 输出gerber资料：点击Gerber Data,弹出窗口：

Data Format 资料格式

点击"Export Path"选择资料所要放的目录下，然后点"Apply",点击 "OK"资料就输入到相应目录下

Drill data 输出钻带

Mill Data 输出锣带
