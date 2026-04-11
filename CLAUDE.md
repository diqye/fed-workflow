
## Project context

这是一个基于`anthropic agent sdk`的前端工作流，用来领取飞书任务，coding, commit,push,feedback merge request.

## About me
我是一名全栈工程师，关注简洁易用的架构、不可变思维、组合子思维、OOP的点语法作为函数式的语法糖。

## Project structure

1. Bun runtime
2. zod schema

```zsh
.
├── CLAUDE.md       # For claude code
├── index.ts        # 通用入口文件
├── README.md       # 项目介绍
└── src             # 源码目录
    ├── cli.ts      # 工具入口文件
    └── const.ts    # 不可变的东西
```


## Zen

1. 代码可读高于代码便捷
2. 只遵循一种解决路径（同一个事情不要用多种解决方案）
3. 运行时抛异常高于隐藏Bug
4. Typescript类型检查优先于运行时抛异常
5. 不要想着局部最优解，敢于重构
6. 减少开死记硬背的东西
7. 关注代码逻辑，代码风格随意

