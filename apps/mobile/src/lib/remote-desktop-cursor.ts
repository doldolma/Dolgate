/**
 * 트랙패드 커서 이미지 — 고전 윈도우 화살표.
 *
 * **왜 인라인 PNG 인가:** 이 앱은 react-native-svg 를 쓰지 않고, 벡터 아이콘 폰트 중 커서
 * 글리프가 있는 것은 MaterialCommunityIcons(1.1MB)뿐이다. 글리프 하나에 폰트를 통째로 넣는
 * 대신, 3x 로 래스터한 617바이트 PNG 를 박는다. 폰트 링크(iOS UIAppFonts / Android
 * iconFontNames)도 건드리지 않는다.
 *
 * 원본 폴리곤은 팁이 (0,0) 인 15x21.8dp 화살표이고, 테두리를 위해 사방 1.4 dp 여백이 있다.
 * 그래서 **핫스팟은 이미지의 (1.4, 1.4) dp** 지점이다 — 그 자리가 클릭 좌표에 오도록 그린다.
 */
export const TRACKPAD_CURSOR_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAC0AAABCCAYAAADDuF8VAAACMElEQVR42u3agY2DMAwAQEbICIzACBkhIzACI7ABI2QERmAERmCEjMDjilSUT9IQHMdItWTpq3/o6Rtcx1BVvygT9ZbyaWCz5bqlfgpa7uD1SfAzGnLaUjwNDTlzhr/RQojHwN9oKeWqtX4E/AMN4YAvWzas0R644QR3oiHGcTyvczZwLxpinmeW8CA6AFes0R44ZMsabeFN07CAR6MhjDEs4JfQAXjPGh2Aa9ZoC1dKFYEno220bUsOv40OwAVrtAeerUNEQ0N0XUcCR0V7OkR0ODo6AK9Zo3P35NnQFp6jtc2KztWTZ0fngJOgsXtyMjQmnBSN1ZOTozHgRdB3e/Ji6DvwoujUnhwdDZMpONfVdIybNRm6ruvVM/NOSUmCduwbU9P4OsOkEcIwDK9l4Ippms5vrvb3uZoiy7AGgBFLpCu2c3GVJ7jqI3rppQjaU09fCb9z/f2px1CkaM/gcbE/930fs8mdSg7VbY/Q2tewfl2xLMv5uPx7xIhhur09/VrDEeVPZ0VH7jT6b0vrVP4M1ijhH/rC1qg+fvywHKjK3wc64Y6WLlH+QreZYzafH8dTlb/QDf3Y3fJsj4Ovd4ryJ6v7TyCQlz+JMCwUx/Ln60cwy1+DNN0c7HkAR1H+1F6K7pykWPm7G6MFwYVXovtL/cSc5Q/+81DHHWWVxVMNy7EfgW9Xx077eA2xiC5i7zeXfBjga/mr/j86JyumoR3zi6ZiHmKHDpiN/y9+EYg/zjWjvx8edgEAAAAASUVORK5CYII=';

/** 이미지 표시 크기(dp). 3x 자산(45x66px)을 그대로 축소해 쓴다. */
export const TRACKPAD_CURSOR_WIDTH = 15;
export const TRACKPAD_CURSOR_HEIGHT = 22;

/** 이미지 좌상단 기준 화살표 팁의 위치(dp). 이만큼 당겨서 팁을 좌표에 맞춘다. */
export const TRACKPAD_CURSOR_HOTSPOT_X = 1.4;
export const TRACKPAD_CURSOR_HOTSPOT_Y = 1.4;
