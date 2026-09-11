# belayo 的镜像仓库

belayo 上的容器应用（`teamclu.app.json` 里 `build.kind: "container"`）要有个地方放镜像。
ACR 个人版已经无法新建、企业版按实例收费，所以跟 self-host 一样自建一个。

区别只在托管方式：self-host 那份跑在盒子的 docker compose 里、由 Caddy 挡在前面
（`deploy/self-host/docker-compose.yml` 的 `registry` profile），belayo 这份跑在
Dokploy 上、由它的 Traefik 挡在前面。**FC 侧的代码完全一样**，两边都只是给
`APPS_REGISTRY_*` 填不同的值。

## 部署位置

Dokploy（`https://service.ucar.cc`，47.107.171.43）→ 项目 **infra** → 新建一个
**Compose** 类型的服务，名字 `teamclu-registry`，把 `docker-compose.yml` 贴进去。

主机名用 `registry.service.ucar.cc`：`*.service.ucar.cc` 已经有泛解析 A 记录指向
这台机器，**不需要加 DNS**。Traefik 会自己去 Let's Encrypt 申请证书。

## 需要填的环境变量（在 Dokploy 那个栈的 Environment 里，不要进仓库）

| 变量 | 值 |
|---|---|
| `REGISTRY_HOST` | `registry.service.ucar.cc` |
| `REGISTRY_OSS_BUCKET` | `belayo-teamclu-apps`（跟 belayo 的 `APPS_OSS_BUCKET` 同一个） |
| `REGISTRY_OSS_REGION` | `cn-shenzhen` |
| `REGISTRY_OSS_ENDPOINT` | `https://oss-cn-shenzhen.aliyuncs.com` |
| `REGISTRY_OSS_ACCESS_KEY` / `REGISTRY_OSS_SECRET_KEY` | belayo FC 用的那对 `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` |
| `REGISTRY_PUSH_AUTH` | 写权限账号的 htpasswd 行 |
| `REGISTRY_PULL_AUTH` | 只读账号的 htpasswd 行 |

两个 htpasswd 行这样生成：

```bash
htpasswd -nbB teamclu-push '<push 密码>'
htpasswd -nbB teamclu-pull '<pull 密码>'
```

**stack 模式原样粘贴，单个 `$`**（上面第 3 点）。哪天改回 compose 类型跑，就要把每个
`$` 写成 `$$` —— 两种模式的转义规则是反的，错了症状一样：全部 401，日志里什么都看不出来。

读路由上**两个账号都要收**（compose 里已经是 `${REGISTRY_PULL_AUTH},${REGISTRY_PUSH_AUTH}`）：
`docker login` 第一件事是打 `GET /v2/`，只认 pull 账号的读路由会把 push 账号
在它推任何东西之前就挡掉，报的还是 `login attempt ... 401 Unauthorized`。

## 然后配 FC

belayo 的 FC 是手工部署的（`services/fc/deploy-aliyun-fc.sh` + `.env.belayo.local`），
在那个 env 文件里加：

```
APPS_REGISTRY_HOST=registry.service.ucar.cc
APPS_REGISTRY_NAMESPACE=apps
APPS_REGISTRY_USERNAME=teamclu-push
APPS_REGISTRY_PASSWORD=<push 密码明文>
APPS_REGISTRY_PULL_USERNAME=teamclu-pull
APPS_REGISTRY_PULL_PASSWORD=<pull 密码明文>
APPS_REGISTRY_PULL_HOST=
```

明文密码给 FC 是必须的：它要把 push 那对发给开发者的机器去推镜像，把 pull 那对
烘进函数配置让 FC 去拉。Traefik 那边存的是同样两个密码的 bcrypt 哈希。

`APPS_REGISTRY_PULL_HOST` 留空 —— FC 从公网按同一个名字拉。

## 验证

```bash
# 只读账号推不上去（应当 401）
echo FROM scratch | docker build -t registry.service.ucar.cc/apps/probe:v1 -
docker login registry.service.ucar.cc -u teamclu-pull   # 输 pull 密码
docker push registry.service.ucar.cc/apps/probe:v1      # 期望 401

# 写账号推得上去、两个账号都拉得下来
docker login registry.service.ucar.cc -u teamclu-push
docker push registry.service.ucar.cc/apps/probe:v1
docker pull registry.service.ucar.cc/apps/probe:v1
```

## 已知代价

镜像字节是**穿过这个容器**流的，不是重定向到 OSS（驱动拼出来的 OSS URL 没有给
客户端签名，重定向会让 pull 在 manifest 成功之后 403 在 blob 上）。所以推拉都吃
Dokploy 那台机器的带宽。这个 Swarm 资源本来就不宽裕，内存限了 512M —— 它只是转发
字节，自己不做缓存。
