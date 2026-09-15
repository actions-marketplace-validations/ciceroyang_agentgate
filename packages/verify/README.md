# crosscheck

Check what an AI just told you — with a different model.

> **Where this is going, and why not here.** A "verify this answer" button is a feature
> inside somebody else's product and will be shipped as one. The domain worth building
> in is the integrity of what arrives at a person or at the agent acting for them:
> adversarial, cross-boundary, and misaligned enough that no single vendor can settle
> it. See [docs/why-this-lasts.md](docs/why-this-lasts.md). The engine below is a
> first working piece of that, not the product.
## 为什么要用另一个模型

同一个模型检查自己不算验证。厂商也不可能说"用别人来核我"。

crosscheck 是个壳子:模型即插即用,而**回答的模型和复核的模型不是同一个**。这是这套东西唯一真正的结构性优势。

## 它不给可信度分数

原因是分数本身就是一句新的、没人核对过的话,由一个专门用来指出这种话的工具生产出来,很荒谬。

每一条只会有三种状态:

- **有依据**:答案之外有东西支持它(链接能打开等)
- **被推翻**:答案之外有东西和它冲突(链接 404、日期不存在、"Smarch" 不是月份)
- **查不了**:没人查,或者查不动

第三种是最常见的,也是最重要的。它不会被悄悄算成"通过"。

## 现在能查什么

```sh
cat answer.txt | node bin/crosscheck.mjs            # 会去访问链接
node bin/crosscheck.mjs --file answer.txt --no-network
```

这一版是**离线可判的那部分**:引用的链接能不能打开、日期是否成立、有引用标记却没有参考文献。语义层面的核对(这条结论有没有被来源支持)需要接模型,是下一步。

## 它还不是给人用的产品

现在是个引擎,命令行跑。要变成普通人能用的东西,是**一个浏览器扩展,长在你已经在用的 AI 聊天页面上** —— 不新开一个网站,不要求改变习惯。

## 已知的坑,先说清

- 主张抽取是启发式的,**会漏、也会多**。
- 判错"被推翻"比没有工具更糟,所以规则宁可保守,查不动就写查不了。
- 只检查"可检查的东西"。观点、建议、文风不检。
