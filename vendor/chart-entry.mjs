// 막대 차트에 필요한 Chart.js 컴포넌트만 등록해 전역에 노출한다.
// build.js 가 이 번들을 북마크릿에 인라인하므로 CDN 없이 CSP 환경에서도 차트가 그려진다.
import {
  Chart,
  BarController,
  BarElement,
  CategoryScale,
  LinearScale,
  Tooltip,
  Legend,
  Title,
} from 'chart.js';

Chart.register(BarController, BarElement, CategoryScale, LinearScale, Tooltip, Legend, Title);
window.Chart = Chart;
