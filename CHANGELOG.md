# [0.3.0](https://github.com/kim-se-hee/tistory-mcp/compare/v0.2.0...v0.3.0) (2026-06-15)


### Bug Fixes

* skin-toc.ts TOC 블록 라이브 동기화 ([9a12bbe](https://github.com/kim-se-hee/tistory-mcp/commit/9a12bbe9eef0b146ecedc08051b7cfcffe91cfb1))
* update_post 태그 미지정 시 현재 태그 보존 ([bd30d62](https://github.com/kim-se-hee/tistory-mcp/commit/bd30d62f9d94fbc10bcb3dd613b75ec6c60a3777))


### Features

* 이미지 영구화 attachments 배선 ([98593ff](https://github.com/kim-se-hee/tistory-mcp/commit/98593ff6adb5d3c8c61649024d972afb4fdc5937))
* api.ts 세션 만료 감지 강화 ([45163f5](https://github.com/kim-se-hee/tistory-mcp/commit/45163f5715e06f08d4c66b4a04f90c079e3c2e1c))
* api.ts 이미지 헤더 dimension 파서 추가 ([f7793c0](https://github.com/kim-se-hee/tistory-mcp/commit/f7793c0e5eeed6d0695208a3fb5d0418e8359e9b))
* categories_update 하위/이동/visibility 지원 ([83bdbd5](https://github.com/kim-se-hee/tistory-mcp/commit/83bdbd53f9b5ee28d122f799d8c66ef54fda14e8))
* delete_post 숫자 postId 직행 ([97c3bc0](https://github.com/kim-se-hee/tistory-mcp/commit/97c3bc055836ab9b827cc6e992377bf36d271a68))
* delete_post blogUrl 강제 + 삭제 대상 host 표기 ([b491c4e](https://github.com/kim-se-hee/tistory-mcp/commit/b491c4ed019fb8d0db9a22c27b4285e7e716feb0))
* MD→HTML 변환 내장 (블로커 A) ([a8f9890](https://github.com/kim-se-hee/tistory-mcp/commit/a8f9890cee3336501a3536d085735a76253f978a))
* publish_post 카테고리 상태 노출 및 미분류 가드 ([44e672d](https://github.com/kim-se-hee/tistory-mcp/commit/44e672db5cb8b043b5cc9de1aa4cf5cf6cbd7c34))
* publish_post blogUrl 강제 + 발행 대상 host 표기 ([9d8217e](https://github.com/kim-se-hee/tistory-mcp/commit/9d8217e90ff938f9c4ba2b50759adb7e63cc2bf0))
* publish_post published/protected/public 발행 가드 추가 ([f39c703](https://github.com/kim-se-hee/tistory-mcp/commit/f39c7038e2962074035259ed0f64677b24375c9a))
* skin-toc 드리프트 가드 추가 ([0eaac52](https://github.com/kim-se-hee/tistory-mcp/commit/0eaac52cb05a948a2e8945c27659f20ba4d2343a))
* update_post 되박기 오염 가드 추가 ([ba31b38](https://github.com/kim-se-hee/tistory-mcp/commit/ba31b387a0ec8bd56e70b35c5b7a99fe35e58dc5))
* update_post 숫자 postId 직행 ([54691a7](https://github.com/kim-se-hee/tistory-mcp/commit/54691a71f0253fd67e8a8fb035627827d16edffc))
* update_post blogUrl 강제 + 수정 대상 host 표기 ([ba72524](https://github.com/kim-se-hee/tistory-mcp/commit/ba7252406b52a5a785b3bd0160163eaeb5fc68d6))
* upload_image 픽셀 크기 자동 채움 ([d3253e7](https://github.com/kim-se-hee/tistory-mcp/commit/d3253e704a4e983cd9536f70a6809b8f8b672536))

# [0.2.0](https://github.com/kim-se-hee/tistory-mcp/compare/v0.1.6...v0.2.0) (2026-06-08)


### Features

* 현재 스킨 HTML/CSS 조회 도구 tistory_fetch_skin 추가 ([5c5d2f2](https://github.com/kim-se-hee/tistory-mcp/commit/5c5d2f2bbbf4c1bac5fdacbe4ed53bcf0f933a62))

## [0.1.6](https://github.com/kim-se-hee/tistory-mcp/compare/v0.1.5...v0.1.6) (2026-05-27)

## [0.1.5](https://github.com/kim-se-hee/tistory-mcp/compare/v0.1.4...v0.1.5) (2026-05-27)

## [0.1.4](https://github.com/kim-se-hee/tistory-mcp/compare/v0.1.3...v0.1.4) (2026-05-27)

## [0.1.3](https://github.com/kim-se-hee/tistory-mcp/compare/v0.1.2...v0.1.3) (2026-05-27)

## [0.1.2](https://github.com/kim-se-hee/tistory-mcp/compare/v0.1.1...v0.1.2) (2026-05-27)


### Features

* postinstall 시 Chromium 자동 다운로드 ([de6fc16](https://github.com/kim-se-hee/tistory-mcp/commit/de6fc16620d50d641a4dec2f948a2749134d7461))

## [0.1.1](https://github.com/kim-se-hee/tistory-mcp/compare/d7844ff39f23aefce187538c91fc7b58a957e6f4...v0.1.1) (2026-05-27)


### Bug Fixes

* browser — Windows Credential Manager 2560B 한도 청킹 ([bb01e70](https://github.com/kim-se-hee/tistory-mcp/commit/bb01e70ae69d6da07782c445650bc36e6f8b7c89)), closes [host#N](https://github.com/host/issues/N)
* src/index.ts wiring 누락 수정 — 13 tools + 4 resources + 3 prompts 등록 ([4287fe8](https://github.com/kim-se-hee/tistory-mcp/commit/4287fe8fea237a3b2845578773b5c26d6d1d99c8))
* window.Config 파싱 강건화 + BlogConfig 실측 스키마 반영 ([ac379ca](https://github.com/kim-se-hee/tistory-mcp/commit/ac379ca9761a95d91ac4c7be1b9505262825170a))


### Features

* 글 CRUD 도구 3종 (publish/update/delete) 구현 ([1eafaef](https://github.com/kim-se-hee/tistory-mcp/commit/1eafaefc344c9714f92718b003f00a07fa88f2b3))
* 스킨 치환자 카탈로그 catalog.ts 추가 ([d7844ff](https://github.com/kim-se-hee/tistory-mcp/commit/d7844ff39f23aefce187538c91fc7b58a957e6f4))
* api.ts — 11 endpoint cookie-auth fetch 래퍼 추가 ([63a1ee8](https://github.com/kim-se-hee/tistory-mcp/commit/63a1ee81f126bfd310aa9a0acb90e0159510e7e0))
* browser.ts — Playwright session_init + keytar 저장 ([986fe14](https://github.com/kim-se-hee/tistory-mcp/commit/986fe14a2d2041063c5647b286f7b4d3db55a2bd))
* fetch_meta.ts 구현 (admin window.Config.blog 한 방 + 공개 폴백) ([bbe447d](https://github.com/kim-se-hee/tistory-mcp/commit/bbe447ddc5e1903ae022c7723dc9559bf6f86115))
* fetch_post.ts 구현 (공개 페이지 한 방 본문+메타 조회) ([daef1c0](https://github.com/kim-se-hee/tistory-mcp/commit/daef1c0d77d9c92bae78f1c01c5e66c775e66e1f))
* MCP resources 4종 추가 (substitutions/page-types/gotchas/template-default) ([0fe3dac](https://github.com/kim-se-hee/tistory-mcp/commit/0fe3dac485cac96067dfc8ec2aaaa4492f649ac6))
* parallel-todo 워크플로우 스킬·서브에이전트 추가 ([c36968b](https://github.com/kim-se-hee/tistory-mcp/commit/c36968b1d09d0966a0a0a9538952837c6b8fb88f))
* prompts 3종 (new_skin / diagnose_render / iterate_loop) 추가 ([f6c10c5](https://github.com/kim-se-hee/tistory-mcp/commit/f6c10c5f67090d3ca9905d0a7129a3084caa1b14))
* scraper.ts 공개 페이지 cheerio 파서 추가 ([31881ae](https://github.com/kim-se-hee/tistory-mcp/commit/31881ae693efb2d5e2b6422917b12a04bf18f5df))
* skin_validate 도구 추가 ([ee86f8e](https://github.com/kim-se-hee/tistory-mcp/commit/ee86f8e9dd0d9379db0f8a1eb5da301ff66e7866))
* templates/gallery — 썸네일 그리드 갤러리 스킨 추가 ([7770ae9](https://github.com/kim-se-hee/tistory-mcp/commit/7770ae9e8c64aaed625f3d69622fa5b8c0fb9eee))
* templates/magazine — 가로 카드형 매거진 스킨 추가 ([8ea7947](https://github.com/kim-se-hee/tistory-mcp/commit/8ea79477338d900128cbddff4319aa0d1a9802e7))
* tistory_apply_skin / apply_skin_settings 도구 추가 ([88cc8be](https://github.com/kim-se-hee/tistory-mcp/commit/88cc8bedc514d50ad10c05d8956bfc49e8b704ae))
* tistory_categories_update 도구 + api.ts 카테고리 GET/PUT 헬퍼 ([1db9b69](https://github.com/kim-se-hee/tistory-mcp/commit/1db9b69ac1d113289e1ae9fab89916c06ba0edc6))
* tistory_preview_skin 도구 추가 ([c205f71](https://github.com/kim-se-hee/tistory-mcp/commit/c205f71648761e05cefc146506d3c5cbba65b0ee))
* tistory_screenshot 도구 추가 ([7ed4d54](https://github.com/kim-se-hee/tistory-mcp/commit/7ed4d54f172b809d975e401aa76ee2ab818990d3))
* tistory_search_posts 도구 추가 ([082ad10](https://github.com/kim-se-hee/tistory-mcp/commit/082ad1077c2ca821d89562c3b6113720e0b71bc0))
* tistory_session_init 도구 모듈 추가 ([e200a2d](https://github.com/kim-se-hee/tistory-mcp/commit/e200a2da8b7435efc260d2feb1f31e298a59db4f))
* tistory_upload_image 도구 추가 ([f126030](https://github.com/kim-se-hee/tistory-mcp/commit/f1260301d10eaa37b05e519ef8ce5cb9a2f1afe8))
* validator.ts 스킨 정적 검증 모듈 ([6465c73](https://github.com/kim-se-hee/tistory-mcp/commit/6465c73f982a3bd51d0d08ed514f6a1ec840ee1d))
