export const vendorRegionGroups = [
  { label: "전체", districts: [] },
  { label: "서울 강남", districts: ["강남", "논현", "삼성", "서초", "선릉", "수서", "신논현", "양재", "역삼"] },
  { label: "서울 비강남", districts: ["가락", "가산", "강동", "강북", "강서", "건대", "관악", "광진", "구로", "구의", "군자", "금천", "길동", "노원", "답십리", "대림", "도봉", "동대문", "동작", "마곡", "마포", "면목동", "명동", "목동", "미아", "방이", "봉천", "북창", "사가정", "사당", "상봉", "서대문", "서울대", "석계", "성동", "성북", "성수", "송파", "수유", "신길", "신당", "신도림", "신림", "신촌", "쌍문", "양천", "여의도", "연신내", "영등포", "왕십리", "용산", "은평", "을지로", "잠실", "장안", "제기", "종로", "중구", "중랑", "창동", "천호", "청량리", "태릉", "합정", "홍대", "화곡"] },
  { label: "경기 남부", districts: ["경기", "광주", "경기 남부", "고덕", "광교", "광명", "군포", "동탄", "병점", "분당", "산본", "성남", "송탄", "수원", "수지", "시흥", "안산", "안성", "안양", "여주", "오산", "용인", "이천", "판교", "평촌", "평택", "포승", "하남", "향남", "화성"] },
  { label: "경기 북부", districts: ["가평", "경기 북부", "고양", "구리", "김포", "남양주", "다산동", "동두천", "백석동", "양주", "의정부", "일산", "파주", "포천"] },
  { label: "인천/부천", districts: ["간석", "검단", "계산", "계양", "구월", "남동", "만수", "미추홀", "부천", "부평", "서구", "서창", "송도", "송림동", "숭의동", "연수구", "영종도", "왕길동", "용현동", "인천", "주안", "중구", "청라"] },
  { label: "충청/대전/강원", districts: ["강릉", "강원", "계룡시", "공주", "논산", "당진", "대산", "대전", "동해", "보령", "서산", "서천", "세종", "속초", "아산", "오송", "오창", "원주", "음성", "제천", "증평", "진천", "천안", "청주", "춘천", "충주", "태안", "홍성"] },
  { label: "대구", districts: ["대구"] },
  { label: "구미", districts: ["구미"] },
  { label: "경상/전라/제주", districts: ["거제", "경남", "경산", "경주", "광양", "광주", "군산", "김제", "김천", "김해", "나주", "마산", "목포", "순천", "안동", "양산", "여수", "영천", "완주", "울산", "의성", "익산", "전주", "정읍", "제주도", "진주", "진해", "창원", "통영", "포항"] },
  { label: "부산", districts: ["부산", "북창", "서면", "해운대"] },
] as const;

export const vendorCategories = ["전체", "오피", "건마", "휴게텔", "룸,술", "안마", "출장", "키스"] as const;
export const writableVendorCategories = vendorCategories.filter((item) => item !== "전체");
export type VendorCategory = Exclude<typeof vendorCategories[number], "전체">;

export const isVendorCategory = (value: string): value is VendorCategory => (writableVendorCategories as readonly string[]).includes(value);

export const isVendorRegion = (region: string, district: string) => vendorRegionGroups.some(
  (group) => group.label === region && group.label !== "전체" && (group.districts as readonly string[]).includes(district),
);
