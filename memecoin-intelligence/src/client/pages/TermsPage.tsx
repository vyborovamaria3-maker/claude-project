import { Card, CardContent, CardHeader, CardTitle } from '@/client/components/ui/Card';
import Page from '@/client/components/Page';
 
export default function TermsPage() {
  return (
    <Page seo={{ title: 'Terms' }}>
      <div className="max-w-3xl mx-auto py-8">
        <Card className="bg-ink-800 text-chalk">
          <CardHeader>
            <CardTitle className="text-2xl">Terms and Conditions</CardTitle>
          </CardHeader>
          
          <CardContent className="space-y-6 text-chalk-dim">
            <p>
              By using this service, you agree to the following terms and conditions.
            </p>
 
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-chalk">1. Acceptance of Terms</h2>
              <p>
                By accessing and using this application, you accept and agree to be bound by the terms and conditions outlined here.
              </p>
            </section>
 
            <section className="space-y-2">
              <h2 className="text-lg font-semibold text-chalk">2. Use of Service</h2>
              <p>
                You agree to use the service only for lawful purposes and in accordance with these terms.
              </p>
            </section>
 
            <p className="text-sm text-chalk-faint">
              {new Date().toLocaleDateString()}
            </p>
          </CardContent>
        </Card>
      </div>
    </Page>
  );
}
 