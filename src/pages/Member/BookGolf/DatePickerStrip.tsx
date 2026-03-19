import React from 'react';
import DateButton from '../../../components/DateButton';

interface DatePickerStripProps {
  dates: Array<{ label: string; date: string; day: string; dateNum: string }>;
  selectedDate: string | undefined;
  onSelectDate: (d: { label: string; date: string; day: string; dateNum: string }) => void;
  isDark: boolean;
}

const DatePickerStrip: React.FC<DatePickerStripProps> = ({ dates, selectedDate, onSelectDate, isDark }) => (
  <div className="flex gap-3 overflow-x-auto py-8 px-3 -mx-3 scrollbar-hide scroll-fade-right">
    {dates.map((d) => (
      <DateButton 
        key={d.date}
        day={d.day} 
        date={d.dateNum} 
        active={selectedDate === d.date} 
        onClick={() => onSelectDate(d)} 
        isDark={isDark}
      />
    ))}
  </div>
);

export default DatePickerStrip;
