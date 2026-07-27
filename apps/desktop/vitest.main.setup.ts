import { initMainI18n } from './src/main/i18n';

// 테스트는 한국어 원문을 기대한다(한국어가 소스 언어). 초기화하지 않으면 t() 가 빈
// 문자열을 돌려줘 메시지 단정이 전부 깨진다.
initMainI18n('ko', 'ko-KR');
