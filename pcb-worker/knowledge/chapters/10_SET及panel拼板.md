# 第十章 SET及panel拼板

<!-- page:148 -->

### 一、成品拼板（SET)

#### 1.在同一step 里面拼板

EDIT copy Step&Repeat

图注（对应 images/10_SET及panel拼板/148_1.png、148_2.png）：

- X，Y方向拼板个数
- X，Y拼板距离

例如：x方向3个，y方向3，零间距拼板，上下加工艺边MM 如图：

（拼板结果图：images/10_SET及panel拼板/148_3.png）

如果需要拼间距，如x方向拼2MM间距 那么就是x方向的尺寸再加2MM.

<!-- page:149 -->

#### 2.在不同step里面拼板

建立Step (set）注意EDIT（单只零点及profile一定要对，不要搞错了）打开set

1）Step panelizcation step repeat table

图注（对应 images/10_SET及panel拼板/149_1.png）：

- 点击输入单只STEp
- 镜像"yes"表示镜像"No"表示不镜像，一般选择NO
- 基准点
- 拼板个数XY方向
- 拼板距离XY方向
- 角度

拼好之后需要加工艺边，再定好Profie及零点。

<!-- page:150 -->

2）、Step panelizcation S&R EDIT

图注（对应 images/10_SET及panel拼板/150_1.png、150_2.png）：

- 预留边
- 单元与单元之间间距
- 添加简化打散对齐
- 复制移动替换删除
- 左右镜像上下镜像阴阳旋转
- 对齐
- 选择
- 输入拼板尺寸

<!-- page:151 -->

3）、成品如果是自行拼板，一般工艺边要加定位孔和mark点，客户提供的，板内没有定位孔及mark点也需要加，如板内有可以不加；

4）如果客户资料中有说明工艺边参考前版本或其他板，工艺边上的东西要与参考版一致；

5）如果工艺边上要求铺铜，需要避开工艺边上的孔及mark点。

（示例图：images/10_SET及panel拼板/151_1.png）

<!-- page:152 -->

### 二、生产panel拼板

#### 1.建立panel

图注（对应 images/10_SET及panel拼板/152_1.png、152_2.png）：

- 1.拼板对象
- 2.拼板示意图
- 3.模式
- 4.拼板对象个数
- 5拼板尺寸
- 6到板边距离
- 7.板与板之间距离
- 8.拼板方向

选好参数后点击OK即可

<!-- page:153 -->

#### 2.生产panel板边填充：内层外层线路板边加阻流pad及铜皮

填充板边: Step Panelization Pattern Fill （参数设置一般如下图）

（参数图：images/10_SET及panel拼板/153_1.png、153_2.png）

<!-- page:154 -->

阻流块填，单击上图中的Fill parameters…按下图设置好，再回到上图去填充

（参数图：images/10_SET及panel拼板/154_1.png）

<!-- page:155 -->

#### 3.生产板边加定位孔（方向孔），挂孔，AOI孔及铆钉孔（AOI和铆钉孔不用钻）及其它标志，注意每个工厂设计有可能是不一样的，具体看工厂制成能力。

板边一般不需要自己去加，一般都是脚本自动加

（示例图：images/10_SET及panel拼板/155_1.png）
