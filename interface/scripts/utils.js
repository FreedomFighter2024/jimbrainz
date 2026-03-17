export function convertTime(dateObj) {
  let hours = dateObj.getHours(); 
  let minutes = dateObj.getMinutes(); 
  let seconds = dateObj.getSeconds();
  const pad = (num) => num.toString().padStart(2, '0');
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}