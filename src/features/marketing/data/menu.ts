export type Category = 'all' | 'mains' | 'pasta' | 'light';
export const menuItems = [
  { id: 'burger', category: 'mains' as Category, image: '/media/burger.jpg', name: { ar: 'برجر البيت', en: 'House burger' }, description: { ar: 'بيف مشوي، شيدر وصوص البيت', en: 'Grilled beef, cheddar & house sauce' }, price: 185, largePrice: 225 },
  { id: 'pasta', category: 'pasta' as Category, image: '/media/pasta.jpg', name: { ar: 'باستا بيستو', en: 'Pesto pasta' }, description: { ar: 'ريحان طازة، بارميزان وطماطم', en: 'Fresh basil, parmesan & tomatoes' }, price: 155, largePrice: 195 },
  { id: 'salad', category: 'light' as Category, image: '/media/salad.jpg', name: { ar: 'سلطة الحديقة', en: 'Garden salad' }, description: { ar: 'خضار ملون، صوص ليمون وزيت زيتون', en: 'Colorful greens, lemon & olive oil' }, price: 95, largePrice: 125 },
];
