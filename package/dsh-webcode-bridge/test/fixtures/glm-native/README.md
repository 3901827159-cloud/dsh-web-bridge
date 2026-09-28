# GLM-5.3 真机原生调用形态（2026-09-27 抓取）

来源：`C:\Users\rsyhn\.dsh\logs\webcode-bridge-replies.glm.log`（桥自己落的**真实网页回复全文**，
`note=raw reply, verbatim`），站点 `glm`，会话 `session-75d52255-afd9-4642-b72d-c907c3be7687`
（模型 `glm:glm-5.3`）。**逐字保留**，只把时间戳与记录序号写在本说明里。

这些夹具存在的理由：GLM-5.3 的原生调用格式有 **三种变体**，而旧解析器对其中两种会
产出**错参数**（不是丢调用——比丢更坏：调用发出去了、工具拿到的是垃圾，DSH 回
`invalid arguments: missing required property "file_path"`，模型据此学到的是错的教训，
于是再换一种写法重试，一轮一轮烧掉窗口）。三种变体必须逐字留在仓库里，
否则下一次改解析器时没有任何东西拦得住回归。

## 变体 A —— 裸名 + `key=value` 行 + 收尾 `</arg_value>`（**无线程任何 arg_key 标签**）

`glm-native-a-keyeq-lines.txt`，记录[35] `2026-09-27T09:19:23.933Z`，515 字符。

模型写了三个调用（`read` / `glob` / `read`），形态是：

```
<tool_call>read
file_path=D:\...\README.zh-CN.md
limit=150
<tool_call>glob
path=D:\...\package\dsh-webcode-bridge
pattern=**/*.js</arg_value></tool_call><tool_call>read
file_path=D:\...\package.json</arg_value></tool_call><tool_call>read
file_path=D:\...\doc\README.md
limit=120</arg_value></tool_call>
```

即：**没有 `<arg_key>`**，参数是 `key=value` 行；每个块以一个 `</arg_value>` 收尾
（**没有配对的 `<arg_value>` 开标签**——模型自己写的闭标签漏到了末尾）。
旧解析器把键取成 `md`（`README.md` 的行尾）、把值取成整段残文，
最终派发 `read {"md":"limit=150\n<tool_call>glob\n…"}` → DSH 拒绝。

## 变体 B —— 裸名 + `key\nvalue` 行 + 收尾 `</arg_value>`

`glm-native-b-keybracket.txt`，记录[33] `2026-09-27T09:18:53.947Z`，590 字符。

模型把两个**正确的** ```json 围栏调用写在正文里（那两条解析正常），
本夹具取的是同一条记录里**另一个**形状的片段——见文件正文的注释头。

## 变体 C —— 规范化 `<arg_key>/<arg_value>`（既有实现已支持，作为对照）

`glm-native-c-argkey.txt`，记录[37] `2026-09-27T09:19:55.026Z`，754 字符。

模型写：`<tool_call>read<arg_key>file_path</arg_key><arg_value>…</arg_value><arg_key>limit</arg_key><arg_value>120</arg_value></tool_call>`，
**同一条回复的尾部又跟了两个 ```json 围栏信封**。同一个逻辑调用在一条回复里出现两次
（原生形状 + 围栏信封），解析器必须去重，不能执行两遍。

## 对照：教学模板里的假调用（必须**不**被执行）

`glm-native-d-teaching-placeholder.txt`，记录[34]/[38] 的**思考通道**原文。

模型在思考里写「正确格式是 ```json {"mcp_action":"call","name":"工具名",…}```」——
`工具名` / `tool_name` / `参数名` 是占位符，不是工具。
真机 `lib/index.js:1785` 会把思考通道全文喂给同一个解析器兜底，
因此解析器必须能拒绝不存在的工具名，否则桥会**因为模型描述协议而真的去执行**。
