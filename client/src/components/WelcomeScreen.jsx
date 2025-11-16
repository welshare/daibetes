import { Icon } from "./icons/Icon";

export function WelcomeScreen({ onExampleClick }) {
  const examples = [
    {
      icon: "activity",
      title: "Glucose Monitoring",
      text: "What are the latest advances in continuous glucose monitoring technology?",
    },
    {
      icon: "syringe",
      title: "Insulin Therapy",
      text: "How do different types of insulin work and when should they be used?",
    },
    {
      icon: "pill",
      title: "Diabetes Management",
      text: "What are the most effective medications for type 2 diabetes management?",
    },
  ];

  return (
    <div className="welcome-screen">
      <div className="welcome-header">
        <h1 className="welcome-title">
          <span className="welcome-title-agents">dAIbetes</span>
        </h1>
        <p className="welcome-subtitle">
          AI-powered biological research assistant
        </p>
      </div>

      <div className="welcome-section">
        <h2 className="welcome-section-title">Popular Topics</h2>
        <div className="example-prompts">
          {examples.map((example, index) => (
            <div
              key={index}
              className="example-prompt"
              onClick={() => onExampleClick && onExampleClick(example.text)}
            >
              <div className="example-prompt-icon">
                <Icon name={example.icon} size={20} />
              </div>
              <div className="example-prompt-content">
                <div className="example-prompt-title">{example.title}</div>
                <div className="example-prompt-text">{example.text}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
